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
