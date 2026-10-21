terraform {
  # 1.10+ is required for S3 native state locking (use_lockfile); verified with 1.16.6.
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }

  # The S3 backend is declared in backend.tf. A first-time bootstrap (bucket
  # not created yet) starts without it; see infra/README.md.
}
