# IAM role for the staging deploy workflow (.github/workflows/staging-deploy.yml).
#
# Trust: only the job that runs in the GitHub environment
# `github_deploy_environment` of this repository (immutable `sub`
# `repo:<owner>@<id>/<repo>@<id>:environment:<name>`). Jobs on develop without
# that environment (ECR publish, OIDC check) get a different `sub` and cannot
# assume this role; the deploy job cannot assume the publish role either.
# Which branches may use the environment is set in the GitHub environment's
# deployment branch policy (develop only, see infra/README.md).
#
# Permissions: read image digests, register task definition revisions, run
# the migration task, update the API service, pass only the four booking task
# roles to ECS. No ECR push/delete, no IAM changes, no infrastructure changes,
# no Terraform state access, no log reading (workflow logs of this public
# repository are public, so CloudWatch logs are read by the owner instead).

locals {
  deploy_subject = "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repository}@${var.github_repository_id}:environment:${var.github_deploy_environment}"

  ecs_arn_prefix = "arn:aws:ecs:${var.region}:${var.aws_account_id}"

  booking_task_role_arns = concat(
    [for role in aws_iam_role.booking_execution : role.arn],
    [for role in aws_iam_role.booking_task : role.arn],
  )
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    sid     = "GitHubActionsStagingEnvironmentOnly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.deploy_subject]
    }
  }
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "ReadImageDigests"
    effect    = "Allow"
    actions   = ["ecr:DescribeImages"]
    resources = [for repository in aws_ecr_repository.booking : repository.arn]
  }

  # These two actions do not support resource-level permissions.
  statement {
    sid       = "TaskDefinitions"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "RunMigrationTaskInStagingCluster"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = ["${local.ecs_arn_prefix}:task-definition/${aws_ecs_task_definition.migrate.family}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "ReadTasksInStagingCluster"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = ["${local.ecs_arn_prefix}:task/${aws_ecs_cluster.main.name}/*"]
  }

  statement {
    sid       = "UpdateApiService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [aws_ecs_service.api.id]
  }

  statement {
    sid       = "PassBookingTaskRolesToEcsOnly"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.booking_task_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name_prefix}-github-deploy"
  description          = "GitHub Actions (environment ${var.github_deploy_environment}) deploys booking images to staging ECS."
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy" {
  name   = "staging-deploy-booking"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policies_exclusive" "deploy" {
  role_name    = aws_iam_role.deploy.name
  policy_names = [aws_iam_role_policy.deploy.name]
}

resource "aws_iam_role_policy_attachments_exclusive" "deploy" {
  role_name   = aws_iam_role.deploy.name
  policy_arns = []
}
