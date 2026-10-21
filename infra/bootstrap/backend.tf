# Remote state in the bucket this configuration manages. Partial
# configuration: bucket, key, region, encrypt and use_lockfile come from an
# ignored file created from ../backend-config/bootstrap.s3.tfbackend.example:
#   terraform init -backend-config=../backend-config/bootstrap.s3.tfbackend
# Credentials come from the environment (e.g. AWS_PROFILE), never from here.
# CI runs `terraform init -backend=false` and does not touch this backend.
terraform {
  backend "s3" {}
}
