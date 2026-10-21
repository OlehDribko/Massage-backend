output "state_bucket_name" {
  description = "Name of the Terraform state bucket (use as `bucket` in the backend configs)."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state bucket."
  value       = aws_s3_bucket.state.arn
}

output "state_bucket_region" {
  description = "Region of the Terraform state bucket."
  value       = var.region
}

output "state_keys" {
  description = "Planned state object keys (bootstrap, staging, production)."
  value       = local.state_keys
}

output "github_oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "github_oidc_check_role_arn" {
  description = "ARN of the OIDC sign-in check role (repository variable AWS_OIDC_CHECK_ROLE_ARN)."
  value       = aws_iam_role.github_oidc_check.arn
}

output "github_oidc_check_subject" {
  description = "Exact `sub` claim the check role trusts."
  value       = local.github_oidc_check_subject
}
