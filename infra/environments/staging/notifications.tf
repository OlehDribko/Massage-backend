# Booking notifications worker (docs/notifications.md): a separate ECS
# service running the booking-api image with `node dist/notifications/main.js`.
# No inbound traffic, no load balancer, no service discovery: it only polls
# the database and calls the Brevo API.
#
# Ownership: unlike the API, Terraform owns the worker's image
# (var.booking_notifications_image); the deploy workflow does not touch this
# service, and the deploy role cannot pass the worker's roles. desired_count
# is set by the operator (`aws ecs update-service --desired-count 1|0`), like
# the API's pause; the service is created with 0.
#
# Recipients: outside production the worker sends only to
# notification_recipient_allowlist (the application refuses to start without
# it); other recipients are recorded as skipped.
#
# Database: own PostgreSQL role (booking_notifier) with SELECT on
# "OutboxEvent" and SELECT/INSERT/UPDATE on the two notification tables only.
# The role and both SSM parameters are created by the owner, outside
# Terraform (infra/staging-deploy.md).

locals {
  notifications_container = "booking-notifications"
  notifications_log_group = "/ecs/${var.name_prefix}/booking-notifications"

  notifications_parameters = {
    database_url  = "${local.ssm_parameter_prefix}/notifications-database-url"
    brevo_api_key = "${local.ssm_parameter_prefix}/brevo-api-key"
  }

  notifications_parameter_arns = {
    for key, name in local.notifications_parameters :
    key => "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${name}"
  }
}

# No ingress at all; HTTPS (ECR, CloudWatch Logs, SSM, Brevo) and PostgreSQL
# (Neon) out.
resource "aws_security_group" "notifications" {
  name        = "${var.name_prefix}-notifications"
  description = "Booking notifications worker: no ingress; HTTPS and PostgreSQL out"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-notifications"
  }
}

resource "aws_vpc_security_group_egress_rule" "notifications_https" {
  security_group_id = aws_security_group.notifications.id
  description       = "HTTPS to ECR, CloudWatch Logs, SSM, Brevo"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "notifications_postgres" {
  security_group_id = aws_security_group.notifications.id
  description       = "PostgreSQL (TLS) to Neon"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_cloudwatch_log_group" "notifications" {
  name              = local.notifications_log_group
  retention_in_days = var.log_retention_days
}

# Execution role: pull the booking-api image, write own logs, read the two
# worker parameters. Not the API's database URL, not the Firebase key.
data "aws_iam_policy_document" "notifications_execution" {
  # GetAuthorizationToken does not support resource-level permissions.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullApiImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.booking["booking_api"].arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.notifications.arn}:log-stream:*"]
  }

  statement {
    sid       = "ReadOwnSecrets"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = values(local.notifications_parameter_arns)
  }
}

resource "aws_iam_role" "notifications_execution" {
  name                 = "${var.name_prefix}-booking-notifications-execution"
  description          = "ECS agent for booking-notifications: pull the API image, write own logs, read own secrets."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "notifications_execution" {
  name   = "booking-notifications-execution"
  role   = aws_iam_role.notifications_execution.id
  policy = data.aws_iam_policy_document.notifications_execution.json
}

resource "aws_iam_role_policies_exclusive" "notifications_execution" {
  role_name    = aws_iam_role.notifications_execution.name
  policy_names = [aws_iam_role_policy.notifications_execution.name]
}

resource "aws_iam_role_policy_attachments_exclusive" "notifications_execution" {
  role_name   = aws_iam_role.notifications_execution.name
  policy_arns = []
}

# The worker calls no AWS API: its task role has no permissions.
resource "aws_iam_role" "notifications_task" {
  name                 = "${var.name_prefix}-booking-notifications-task"
  description          = "Identity of the booking-notifications container. No AWS permissions."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policies_exclusive" "notifications_task" {
  role_name    = aws_iam_role.notifications_task.name
  policy_names = []
}

resource "aws_iam_role_policy_attachments_exclusive" "notifications_task" {
  role_name   = aws_iam_role.notifications_task.name
  policy_arns = []
}

resource "aws_ecs_task_definition" "notifications" {
  family                   = "${var.name_prefix}-booking-notifications"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.notifications_execution.arn
  task_role_arn            = aws_iam_role.notifications_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.notifications_container
      image     = var.booking_notifications_image
      essential = true
      # Same image as the API (WORKDIR /app/services/booking), other entry point.
      command                = ["node", "dist/notifications/main.js"]
      readonlyRootFilesystem = true
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "ENABLE_BOOKING_NOTIFICATIONS", value = "true" },
        { name = "NOTIFICATIONS_ENVIRONMENT", value = "staging" },
        { name = "DATABASE_SSL_MODE", value = "verify-full" },
        { name = "DATABASE_POOL_MAX", value = "2" },
        { name = "NOTIFICATION_STUDIO_EMAIL", value = var.notification_studio_email },
        { name = "NOTIFICATION_RECIPIENT_ALLOWLIST", value = join(",", var.notification_recipient_allowlist) },
        { name = "EMAIL_FROM_NAME", value = var.email_from_name },
        { name = "EMAIL_FROM_EMAIL", value = var.email_from_email },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = local.notifications_parameter_arns.database_url },
        { name = "BREVO_API_KEY", valueFrom = local.notifications_parameter_arns.brevo_api_key },
      ]
      linuxParameters = {
        initProcessEnabled = true
      }
      # SIGTERM first; the worker finishes the current pass (provider timeout
      # 20 s) and exits.
      stopTimeout = 30
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.notifications.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "notifications"
        }
      }
    }
  ])

  lifecycle {
    precondition {
      condition     = contains([for email in var.notification_recipient_allowlist : lower(email)], lower(var.notification_studio_email))
      error_message = "notification_studio_email must be in notification_recipient_allowlist, otherwise studio emails are skipped."
    }
  }
}

resource "aws_ecs_service" "notifications" {
  name             = "booking-notifications"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.notifications.arn
  desired_count    = 0
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # One worker at a time is enough (several would also be safe: leases and
  # SKIP LOCKED). On a new revision the old task stops before the new one
  # starts; pending emails wait a few seconds.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets         = local.public_subnet_ids
    security_groups = [aws_security_group.notifications.id]
    # No NAT: the public IP is needed to reach ECR, CloudWatch Logs, SSM,
    # Neon and Brevo. No inbound rules.
    assign_public_ip = true
  }

  wait_for_steady_state = false

  lifecycle {
    # Started and paused by the operator (see the header of this file).
    ignore_changes = [desired_count]
  }
}
