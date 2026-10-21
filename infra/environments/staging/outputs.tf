output "vpc_id" {
  description = "ID of the staging VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "IPv4 CIDR of the staging VPC."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (one per availability zone) for the ECS tasks."
  value       = [for zone in var.availability_zones : aws_subnet.public[zone].id]
}

output "availability_zones" {
  description = "Availability zones of the public subnets, in the same order as public_subnet_ids."
  value       = var.availability_zones
}

output "alb_security_group_id" {
  description = "Security group for the future ALB."
  value       = aws_security_group.alb.id
}

output "api_security_group_id" {
  description = "Security group for the booking API tasks."
  value       = aws_security_group.api.id
}

output "app_port" {
  description = "Booking API container port allowed from the ALB."
  value       = var.app_port
}

output "ecr_repository_urls" {
  description = "ECR repository URLs: booking_api (runtime target) and booking_migrate (migrate target). Shared with production."
  value       = { for key, repository in aws_ecr_repository.booking : key => repository.repository_url }
}

output "ecr_repository_arns" {
  description = "ECR repository ARNs for future IAM policies (push from CI, pull by ECS)."
  value       = { for key, repository in aws_ecr_repository.booking : key => repository.arn }
}

output "ecr_publish_role_arn" {
  description = "ARN of the ECR publish role (repository variable AWS_ECR_PUBLISH_ROLE_ARN)."
  value       = aws_iam_role.ecr_publish.arn
}

output "ecr_publish_subject" {
  description = "Exact `sub` claim the ECR publish role trusts."
  value       = local.ecr_publish_subject
}

output "api_base_url" {
  description = "Technical HTTPS address of the booking API (API Gateway default endpoint)."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "deploy_role_arn" {
  description = "ARN of the staging deploy role (repository variable AWS_STAGING_DEPLOY_ROLE_ARN)."
  value       = aws_iam_role.deploy.arn
}

output "deploy_subject" {
  description = "Exact `sub` claim the staging deploy role trusts."
  value       = local.deploy_subject
}

output "booking_secret_parameter_names" {
  description = "SSM SecureString parameters to create outside Terraform (values never pass through Terraform)."
  value       = local.booking_parameters
}

# Repository variables of the deploy workflow (no secrets).
output "deploy_workflow_variables" {
  description = "Values for the repository variables used by .github/workflows/staging-deploy.yml."
  value = {
    AWS_STAGING_DEPLOY_ROLE_ARN    = aws_iam_role.deploy.arn
    STAGING_ECS_CLUSTER            = aws_ecs_cluster.main.name
    STAGING_ECS_SERVICE            = aws_ecs_service.api.name
    STAGING_API_TASK_FAMILY        = aws_ecs_task_definition.api.family
    STAGING_MIGRATE_TASK_FAMILY    = aws_ecs_task_definition.migrate.family
    STAGING_MIGRATE_SUBNET_IDS     = join(",", local.public_subnet_ids)
    STAGING_MIGRATE_SECURITY_GROUP = aws_security_group.migrate.id
    STAGING_MIGRATE_LOG_GROUP      = aws_cloudwatch_log_group.booking["migrate"].name
    STAGING_API_BASE_URL           = aws_apigatewayv2_api.api.api_endpoint
  }
}
