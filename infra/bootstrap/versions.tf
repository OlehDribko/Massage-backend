terraform {
  # 1.10+ is required for S3 native state locking (use_lockfile); verified with 1.16.6.
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }

  # No backend block: the bootstrap starts with local state, because the S3
  # bucket that will hold the state is created here. Moving this state into
  # the bucket is a separate, later step (see infra/README.md).
}
