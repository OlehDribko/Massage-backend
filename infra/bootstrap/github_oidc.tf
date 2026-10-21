# GitHub Actions -> AWS via OIDC. This stage only proves that a workflow on
# the develop branch can sign in: the role has NO permissions policies, so a
# session can do nothing beyond calls that need none (sts:GetCallerIdentity).
# It is a sign-in check role, not a deploy role.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"

  # The repository uses immutable subject claims (GitHub REST API
  # actions/oidc/customization/sub: use_immutable_subject = true,
  # use_default = true), so `sub` contains the owner and repository IDs:
  #   repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/BRANCH
  # Jobs that use a GitHub environment get a different `sub` and are rejected.
  github_oidc_check_subject = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repository}@${var.github_repository_id}:ref:refs/heads/develop"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
  # No thumbprint_list: for GitHub, IAM validates the certificate against its
  # own trusted CAs and ignores configured thumbprints.

  tags = {
    Component = "github-oidc"
  }
}

data "aws_iam_policy_document" "github_oidc_check_trust" {
  statement {
    sid     = "GitHubActionsDevelopBranchOnly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
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
      values   = [local.github_oidc_check_subject]
    }
  }
}

resource "aws_iam_role" "github_oidc_check" {
  name                 = "massage-backend-github-oidc-check"
  description          = "Sign-in check for GitHub Actions OIDC (develop branch). No permissions."
  assume_role_policy   = data.aws_iam_policy_document.github_oidc_check_trust.json
  max_session_duration = 3600

  tags = {
    Component = "github-oidc"
  }
}

# Terraform owns the (empty) set of permissions: any inline or managed policy
# attached outside Terraform shows up as a change and is removed on apply.
resource "aws_iam_role_policies_exclusive" "github_oidc_check" {
  role_name    = aws_iam_role.github_oidc_check.name
  policy_names = []
}

resource "aws_iam_role_policy_attachments_exclusive" "github_oidc_check" {
  role_name   = aws_iam_role.github_oidc_check.name
  policy_arns = []
}
