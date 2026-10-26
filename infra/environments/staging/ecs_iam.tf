# IAM roles of the booking ECS tasks.
#
# Execution roles are used by the ECS agent (not by the application) to pull
# the image, write logs and resolve secrets at task start. Each image type has
# its own role, limited to its own repository, log group and parameter.
#
# Task roles are the identity of the running containers. The booking service
# does not call AWS APIs, so both task roles have no permissions at all; the
# exclusive resources keep it that way.
#
# Secrets are SSM Parameter Store SecureString parameters encrypted with the
# AWS managed key alias/aws/ssm. They are created outside Terraform (see
# infra/README.md); Terraform only knows their names, never their values, so
# values appear neither in Git nor in plan or state. The AWS managed key's
# policy already allows decryption through SSM for principals of this account,
# so no kms:Decrypt statement is needed.

locals {
  ssm_parameter_prefix = "/${var.name_prefix}/booking"

  booking_parameters = {
    database_url           = "${local.ssm_parameter_prefix}/database-url"
    migration_database_url = "${local.ssm_parameter_prefix}/migration-database-url"
  }

  booking_parameter_arns = {
    for key, name in local.booking_parameters :
    key => "arn:aws:ssm:${var.region}:${var.aws_account_id}:parameter${name}"
  }

  # API (runtime) and migration task: image repository, log group, secret.
  booking_task_kinds = {
    api = {
      repository = aws_ecr_repository.booking["booking_api"].arn
      log_group  = aws_cloudwatch_log_group.booking["api"].arn
      parameter  = local.booking_parameter_arns.database_url
    }
    migrate = {
      repository = aws_ecr_repository.booking["booking_migrate"].arn
      log_group  = aws_cloudwatch_log_group.booking["migrate"].arn
      parameter  = local.booking_parameter_arns.migration_database_url
    }
  }
}

# Only ECS tasks of this account may use the roles (confused-deputy guard).
data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    sid     = "EcsTasksOfThisAccount"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${var.aws_account_id}:*"]
    }
  }
}

data "aws_iam_policy_document" "booking_execution" {
  for_each = local.booking_task_kinds

  # GetAuthorizationToken does not support resource-level permissions.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PullOwnImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [each.value.repository]
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${each.value.log_group}:log-stream:*"]
  }

  statement {
    sid       = "ReadOwnSecret"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = [each.value.parameter]
  }
}

resource "aws_iam_role" "booking_execution" {
  for_each = local.booking_task_kinds

  name                 = "${var.name_prefix}-booking-${each.key}-execution"
  description          = "ECS agent for booking-${each.key}: pull own image, write own logs, read own secret."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "booking_execution" {
  for_each = local.booking_task_kinds

  name   = "booking-${each.key}-execution"
  role   = aws_iam_role.booking_execution[each.key].id
  policy = data.aws_iam_policy_document.booking_execution[each.key].json
}

resource "aws_iam_role_policies_exclusive" "booking_execution" {
  for_each = local.booking_task_kinds

  role_name    = aws_iam_role.booking_execution[each.key].name
  policy_names = [aws_iam_role_policy.booking_execution[each.key].name]
}

resource "aws_iam_role_policy_attachments_exclusive" "booking_execution" {
  for_each = local.booking_task_kinds

  role_name   = aws_iam_role.booking_execution[each.key].name
  policy_arns = []
}

resource "aws_iam_role" "booking_task" {
  for_each = local.booking_task_kinds

  name                 = "${var.name_prefix}-booking-${each.key}-task"
  description          = "Identity of the booking-${each.key} containers. No AWS permissions."
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policies_exclusive" "booking_task" {
  for_each = local.booking_task_kinds

  role_name    = aws_iam_role.booking_task[each.key].name
  policy_names = []
}

resource "aws_iam_role_policy_attachments_exclusive" "booking_task" {
  for_each = local.booking_task_kinds

  role_name   = aws_iam_role.booking_task[each.key].name
  policy_arns = []
}
