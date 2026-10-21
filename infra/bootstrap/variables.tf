variable "aws_account_id" {
  description = "ID of the only AWS account this configuration may manage (checked via allowed_account_ids)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "AWS region for the state bucket."
  type        = string
  default     = "eu-west-3"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must look like an AWS region name, e.g. eu-west-3."
  }
}

variable "state_bucket_prefix" {
  description = "Prefix of the state bucket name. The account ID and region are appended to make a name collision unlikely (availability is checked by AWS on creation)."
  type        = string
  default     = "massage-backend-tfstate"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.state_bucket_prefix))
    error_message = "state_bucket_prefix must be 3-32 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit."
  }
}

# GitHub repository allowed to use the OIDC check role. Owner and repository
# IDs are public and part of the immutable `sub` claim; they only change if
# the repository is recreated (then the trust policy must be updated).
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
