locals {
  # S3 bucket names share one global namespace. Account ID + region make a
  # collision unlikely but do not guarantee the name is free: AWS checks that
  # only when the bucket is created. Max length: 32 + 1 + 12 + 1 + 14 < 63.
  state_bucket_name = "${var.state_bucket_prefix}-${var.aws_account_id}-${var.region}"

  # One bucket, separate state objects. Different keys do NOT restrict access
  # by themselves: IAM policies must limit who may read/write each key.
  state_keys = {
    bootstrap  = "bootstrap/terraform.tfstate"
    staging    = "envs/staging/terraform.tfstate"
    production = "envs/production/terraform.tfstate"
  }
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket_name

  # Never delete objects (state history) together with the bucket.
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

# ACLs disabled: access is controlled only by IAM and the bucket policy.
resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Every state write keeps the previous version (recovery after a bad apply).
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3 (Amazon S3 managed keys).
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "DenyOutdatedTls"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  # The public access block must exist before any bucket policy is attached.
  depends_on = [aws_s3_bucket_public_access_block.state]
}
