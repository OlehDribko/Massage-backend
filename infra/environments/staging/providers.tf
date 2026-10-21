# Credentials come from the environment (e.g. AWS_PROFILE); no profile,
# keys or account-specific values are hard-coded here.
provider "aws" {
  region = var.region

  # Refuses to plan or apply against any other account.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "massage-backend"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}
