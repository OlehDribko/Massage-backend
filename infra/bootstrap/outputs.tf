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
