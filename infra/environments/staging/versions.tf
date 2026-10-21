terraform {
  # Same constraints as infra/bootstrap (S3 native locking needs 1.10+).
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }
}
