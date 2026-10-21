output "vpc_id" {
  description = "ID of the staging VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "IPv4 CIDR of the staging VPC."
  value       = aws_vpc.main.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (one per availability zone) for the ALB and ECS tasks."
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
