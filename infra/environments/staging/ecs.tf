# ECS Fargate for the booking service: cluster, log groups, task definitions
# (API and one-off migration) and the API service.
#
# Ownership split with .github/workflows/staging-deploy.yml:
# - Terraform owns the shape of both task definitions (CPU, memory, roles,
#   environment, secrets, logging, health check) and the service's network,
#   deployment and discovery settings.
# - The deploy workflow owns which image runs: it takes the latest ACTIVE
#   revision of each family, swaps only the image (and APP_VERSION), registers
#   a new revision, runs the migration and points the service at the new API
#   revision. It also owns desired_count.
# Hence the service ignores task_definition and desired_count. A Terraform
# change to a task definition creates a new revision that the next deploy
# picks up as its base; Terraform never rolls a deployed image back.
#
# Initial images (variables booking_*_image) are only used for the first
# revision. The service starts with desired_count = 0: nothing runs until the
# first deploy has run the migration.

locals {
  booking_container = {
    api     = "booking-api"
    migrate = "booking-migrate"
  }

  booking_log_groups = {
    api     = "/ecs/${var.name_prefix}/booking-api"
    migrate = "/ecs/${var.name_prefix}/booking-migrate"
  }

  public_subnet_ids = [for zone in var.availability_zones : aws_subnet.public[zone].id]

  # Liveness only (no database): Cloud Map/API Gateway route to the task while
  # the process serves HTTP; readiness (/health/ready) is checked by the
  # deploy workflow. The runtime image has no curl, so Node's fetch is used.
  api_health_command = "fetch('http://127.0.0.1:${var.app_port}/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

resource "aws_ecs_cluster" "main" {
  name = var.name_prefix

  # Container Insights is billed separately; not needed for staging.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "booking" {
  for_each = local.booking_log_groups

  name              = each.value
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-booking-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.booking_execution["api"].arn
  task_role_arn            = aws_iam_role.booking_task["api"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.booking_container.api
      image     = var.booking_api_image
      essential = true
      # The app writes only to stdout; the image runs as the non-root `node` user.
      readonlyRootFilesystem = true
      portMappings = [
        {
          containerPort = var.app_port
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.app_port) },
        { name = "LOG_LEVEL", value = "info" },
        { name = "DATABASE_SSL_MODE", value = "verify-full" },
        { name = "DATABASE_POOL_MAX", value = "5" },
        { name = "SHUTDOWN_TIMEOUT_MS", value = "10000" },
        { name = "READINESS_TIMEOUT_MS", value = "2000" },
        # Legacy /api/users stays off: no Brevo key or token secret is provided.
        { name = "ENABLE_LEGACY_USER_ROUTES", value = "false" },
        # Firebase Authentication (docs/auth-and-profiles.md, section 8). With
        # REQUIRE_FIREBASE_AUTH the task refuses to start without a working
        # Firebase configuration instead of serving without /api/me.
        { name = "REQUIRE_FIREBASE_AUTH", value = "true" },
        { name = "FIREBASE_PROJECT_ID", value = var.firebase_project_id },
        { name = "FIREBASE_CREDENTIALS", value = "service-account-json" },
        # Replaced with the deployed commit SHA by the deploy workflow.
        { name = "APP_VERSION", value = var.booking_image_commit_sha },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.booking_parameter_arns.database_url },
        { name = "FIREBASE_SERVICE_ACCOUNT_JSON", valueFrom = local.booking_parameter_arns.firebase_service_account },
      ]
      healthCheck = {
        command     = ["CMD", "node", "-e", local.api_health_command]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      linuxParameters = {
        initProcessEnabled = true
      }
      # SIGTERM first; the app drains within SHUTDOWN_TIMEOUT_MS (10 s).
      stopTimeout = 30
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.booking["api"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name_prefix}-booking-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.booking_execution["migrate"].arn
  task_role_arn            = aws_iam_role.booking_task["migrate"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.booking_container.migrate
      image     = var.booking_migrate_image
      essential = true
      # Prisma CLI may write engine files at run time; root filesystem stays writable.
      readonlyRootFilesystem = false
      environment = [
        { name = "MIGRATION_DATABASE_SSL_MODE", value = "verify-full" },
        { name = "BOOKING_RUNTIME_ROLE", value = var.booking_runtime_db_role },
      ]
      secrets = [
        { name = "MIGRATION_DATABASE_URL", valueFrom = local.booking_parameter_arns.migration_database_url },
      ]
      linuxParameters = {
        initProcessEnabled = true
      }
      stopTimeout = 30
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.booking["migrate"].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name             = "booking-api"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.api.arn
  desired_count    = 0
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # Rolling update: the new task starts before the old one stops; a
  # deployment whose tasks never become healthy is rolled back by ECS to the
  # last completed one.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets         = local.public_subnet_ids
    security_groups = [aws_security_group.api.id]
    # No NAT: the public IP is needed to reach ECR, CloudWatch Logs, SSM and
    # Neon. Inbound traffic is still limited to the VPC link group.
    assign_public_ip = true
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = local.booking_container.api
    container_port = var.app_port
  }

  wait_for_steady_state = false

  lifecycle {
    # Owned by the deploy workflow (see the header of this file).
    ignore_changes = [task_definition, desired_count]
  }
}
