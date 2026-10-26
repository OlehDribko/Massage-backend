variable "aws_account_id" {
  description = "ID of the only AWS account this configuration may manage (checked via allowed_account_ids)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS region of the staging environment."
  type        = string
  default     = "eu-west-3"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must look like an AWS region name, e.g. eu-west-3."
  }
}

variable "name_prefix" {
  description = "Prefix for resource names in this environment."
  type        = string
  default     = "massage-staging"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-32 characters: lowercase letters, digits and hyphens."
  }
}

variable "vpc_cidr" {
  description = "IPv4 CIDR of the staging VPC (/16 to /24)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 24
    error_message = "vpc_cidr must be a valid IPv4 CIDR between /16 and /24."
  }
}

variable "availability_zones" {
  description = "Exactly two distinct availability zones in the region (one public subnet each)."
  type        = list(string)
  default     = ["eu-west-3a", "eu-west-3b"]

  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "availability_zones must contain exactly two distinct zones."
  }
}

variable "app_port" {
  description = "Container port of the booking API (PORT in the runtime image, EXPOSE 3001)."
  type        = number
  default     = 3001

  validation {
    condition     = var.app_port >= 1024 && var.app_port <= 65535 && floor(var.app_port) == var.app_port
    error_message = "app_port must be an integer between 1024 and 65535."
  }
}

variable "alb_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach the future ALB on HTTP/HTTPS."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.alb_ingress_cidrs) > 0 && alltrue([for cidr in var.alb_ingress_cidrs : can(cidrhost(cidr, 0))])
    error_message = "alb_ingress_cidrs must be a non-empty list of valid IPv4 CIDRs."
  }
}

variable "ecr_namespace" {
  description = "Namespace of the ECR repositories (<namespace>/booking-api, <namespace>/booking-migrate). Shared by staging and production, so it is independent of name_prefix."
  type        = string
  default     = "massage"

  validation {
    condition     = can(regex("^[a-z0-9]+(?:[._-][a-z0-9]+)*$", var.ecr_namespace))
    error_message = "ecr_namespace must be lowercase letters and digits, optionally separated by '.', '_' or '-'."
  }
}

variable "ecr_untagged_expiry_days" {
  description = "Untagged images older than this many days are expired. Tagged images are never expired automatically."
  type        = number
  default     = 30

  validation {
    condition     = var.ecr_untagged_expiry_days >= 7 && floor(var.ecr_untagged_expiry_days) == var.ecr_untagged_expiry_days
    error_message = "ecr_untagged_expiry_days must be an integer of at least 7."
  }
}

variable "github_oidc_provider_arn" {
  description = "ARN of the existing GitHub Actions OIDC provider (created in infra/bootstrap; `terraform output -raw github_oidc_provider_arn` there)."
  type        = string

  validation {
    condition     = var.github_oidc_provider_arn == "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
    error_message = "github_oidc_provider_arn must be the GitHub OIDC provider in account aws_account_id."
  }
}

# GitHub repository allowed to publish images. Owner and repository IDs are
# public and part of the immutable `sub` claim (same values as in
# infra/bootstrap).
variable "github_owner" {
  description = "GitHub repository owner (login)."
  type        = string
  default     = "OlehDribko"
}

variable "github_owner_id" {
  description = "Numeric GitHub ID of the repository owner."
  type        = string
  default     = "131261254"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be numeric."
  }
}

variable "github_repository" {
  description = "GitHub repository name."
  type        = string
  default     = "Massage-backend"
}

variable "github_repository_id" {
  description = "Numeric GitHub ID of the repository."
  type        = string
  default     = "1318544830"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be numeric."
  }
}

# --- Booking deployment (ECS Fargate, API Gateway) ---

variable "booking_api_image" {
  description = "Initial booking API image, by digest (<registry>/<ecr_namespace>/booking-api@sha256:...). Later deployments register new task definition revisions from the deploy workflow; Terraform does not roll them back."
  type        = string

  validation {
    condition     = can(regex("^${var.aws_account_id}\\.dkr\\.ecr\\.${var.region}\\.amazonaws\\.com/${var.ecr_namespace}/booking-api@sha256:[0-9a-f]{64}$", var.booking_api_image))
    error_message = "booking_api_image must be <account>.dkr.ecr.<region>.amazonaws.com/<ecr_namespace>/booking-api@sha256:<64 hex>."
  }
}

variable "booking_migrate_image" {
  description = "Initial booking migration image, by digest (<registry>/<ecr_namespace>/booking-migrate@sha256:...)."
  type        = string

  validation {
    condition     = can(regex("^${var.aws_account_id}\\.dkr\\.ecr\\.${var.region}\\.amazonaws\\.com/${var.ecr_namespace}/booking-migrate@sha256:[0-9a-f]{64}$", var.booking_migrate_image))
    error_message = "booking_migrate_image must be <account>.dkr.ecr.<region>.amazonaws.com/<ecr_namespace>/booking-migrate@sha256:<64 hex>."
  }
}

variable "booking_image_commit_sha" {
  description = "Commit SHA of the initial images (APP_VERSION of the initial API task definition)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.booking_image_commit_sha))
    error_message = "booking_image_commit_sha must be a full 40-character commit SHA."
  }
}

variable "booking_runtime_db_role" {
  description = "PostgreSQL runtime role that the migration task grants DML to (BOOKING_RUNTIME_ROLE). Must already exist in the staging database."
  type        = string
  default     = "booking_app"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_]{0,62}$", var.booking_runtime_db_role))
    error_message = "booking_runtime_db_role must be a lowercase PostgreSQL role name."
  }
}

variable "api_cpu" {
  description = "Fargate CPU units of the API task (256 = 0.25 vCPU)."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024], var.api_cpu)
    error_message = "api_cpu must be 256, 512 or 1024."
  }
}

variable "api_memory" {
  description = "Memory (MiB) of the API task; must be a valid Fargate combination with api_cpu."
  type        = number
  default     = 512

  validation {
    condition     = contains([512, 1024, 2048], var.api_memory)
    error_message = "api_memory must be 512, 1024 or 2048."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the API, migration and API Gateway access logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "vpc_link_az_ids" {
  description = "AZ IDs where API Gateway VPC links V2 are supported in the region (eu-west-3: euw3-az1, euw3-az3). The VPC link uses only the public subnets in these AZs."
  type        = list(string)
  default     = ["euw3-az1", "euw3-az3"]
}

variable "api_throttling_rate_limit" {
  description = "Steady-state request rate limit (requests/second) of the HTTP API $default route. Also caps the request-driven cost: 2 rps is at most 172,800 requests/day."
  type        = number
  default     = 2
}

variable "api_throttling_burst_limit" {
  description = "Burst limit of the HTTP API $default route."
  type        = number
  default     = 10
}

variable "github_deploy_environment" {
  description = "GitHub environment of the staging deploy job; part of the deploy role's trusted `sub` claim."
  type        = string
  default     = "staging"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.github_deploy_environment))
    error_message = "github_deploy_environment must be 1-64 characters [A-Za-z0-9_-]."
  }
}
