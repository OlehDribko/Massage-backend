# IAM role for GitHub Actions to publish booking images to the two ECR
# repositories in this root. Uses the existing GitHub OIDC provider created in
# infra/bootstrap (its ARN is passed in explicitly; this root never reads the
# bootstrap state).
#
# Trust: only tokens whose `sub` is exactly the develop branch of this
# repository (immutable subject format). Pull requests get a different `sub`
# (`...:pull_request`) and are rejected. The trust is per repository/ref, not
# per workflow: any job running on develop with `id-token: write` (currently
# ecr-publish.yml and aws-oidc-check.yml) could assume this role. The regular
# CI never requests a token.
#
# Permissions: ECR login plus push/read on the two repositories. No delete,
# no repository/infrastructure changes, no IAM, ECS or S3 state access.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"

  ecr_publish_subject = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repository}@${var.github_repository_id}:ref:refs/heads/develop"
}

data "aws_iam_policy_document" "ecr_publish_trust" {
  statement {
    sid     = "GitHubActionsDevelopBranchOnly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    # Exact matches only: no wildcards for repository, branch or pull requests.
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.ecr_publish_subject]
    }
  }
}

data "aws_iam_policy_document" "ecr_publish" {
  # GetAuthorizationToken does not support resource-level permissions.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PushAndReadBookingImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [for repository in aws_ecr_repository.booking : repository.arn]
  }
}

resource "aws_iam_role" "ecr_publish" {
  name                 = "${var.name_prefix}-github-ecr-publish"
  description          = "GitHub Actions (develop) pushes booking images to massage/booking-api and massage/booking-migrate. No delete."
  assume_role_policy   = data.aws_iam_policy_document.ecr_publish_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "ecr_publish" {
  name   = "ecr-publish-booking"
  role   = aws_iam_role.ecr_publish.id
  policy = data.aws_iam_policy_document.ecr_publish.json
}

# Terraform owns the complete set of the role's policies: anything added
# outside Terraform shows up as a change and is removed on apply.
resource "aws_iam_role_policies_exclusive" "ecr_publish" {
  role_name    = aws_iam_role.ecr_publish.name
  policy_names = [aws_iam_role_policy.ecr_publish.name]
}

resource "aws_iam_role_policy_attachments_exclusive" "ecr_publish" {
  role_name   = aws_iam_role.ecr_publish.name
  policy_arns = []
}
