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
