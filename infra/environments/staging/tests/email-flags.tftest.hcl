# Wiring of email settings into the staging API task for every combination of
# enable_booking_notifications and enable_marketing_subscription: one shared
# BREVO_API_KEY while at least one is on, ACTION_TOKEN_SECRET only with
# marketing, nothing (and FRONTEND_URL unchanged) with both off; marketing on
# staging needs the test-recipient list (MARKETING_RECIPIENT_ALLOWLIST).
# Offline: the AWS provider is mocked (no credentials, no state, plan only).
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_subnet" {
    override_during = plan
    defaults        = { availability_zone_id = "euw3-az1", id = "subnet-00000000000000000" }
  }
}

variables {
  aws_account_id                   = "000000000000"
  github_oidc_provider_arn         = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  booking_api_image                = "000000000000.dkr.ecr.eu-west-3.amazonaws.com/massage/booking-api@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  booking_migrate_image            = "000000000000.dkr.ecr.eu-west-3.amazonaws.com/massage/booking-migrate@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  booking_image_commit_sha         = "0000000000000000000000000000000000000000"
  notification_studio_email        = "studio@example.invalid"
  notification_recipient_allowlist = ["studio@example.invalid", "test@example.invalid"]
  email_from_email                 = "sender@example.invalid"
}

run "both_off" {
  command = plan
  variables {
    enable_booking_notifications  = false
    enable_marketing_subscription = false
  }
  assert {
    condition     = join(",", sort([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name])) == "DATABASE_URL,FIREBASE_SERVICE_ACCOUNT_JSON"
    error_message = "both off: only the base secrets"
  }
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e if contains(["EMAIL_FROM_NAME", "EMAIL_FROM_EMAIL", "ENABLE_MARKETING_SUBSCRIPTION", "ENABLE_BOOKING_NOTIFICATIONS", "MARKETING_RECIPIENT_ALLOWLIST"], e.name)]) == 0
    error_message = "both off: no email settings"
  }
  assert {
    condition     = join(",", [for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "FRONTEND_URL"]) == "http://localhost:3000"
    error_message = "both off: FRONTEND_URL unchanged"
  }
  assert {
    condition     = length(flatten([for st in data.aws_iam_policy_document.booking_execution["api"].statement : [for r in(st.sid == "ReadOwnSecrets" ? st.resources : []) : r if strcontains(r, "brevo") || strcontains(r, "action-token")]])) == 0
    error_message = "both off: no IAM access to the Brevo key or action-token secret"
  }
}

run "notifications_only" {
  command = plan
  variables {
    enable_booking_notifications  = true
    enable_marketing_subscription = false
  }
  assert {
    condition     = join(",", sort([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name])) == "BREVO_API_KEY,DATABASE_URL,FIREBASE_SERVICE_ACCOUNT_JSON"
    error_message = "notifications: BREVO_API_KEY only"
  }
  assert {
    condition     = length(flatten([for st in data.aws_iam_policy_document.booking_execution["api"].statement : [for r in(st.sid == "ReadOwnSecrets" ? st.resources : []) : r if strcontains(r, "brevo-api-key")]])) == 1 && length(flatten([for st in data.aws_iam_policy_document.booking_execution["api"].statement : [for r in(st.sid == "ReadOwnSecrets" ? st.resources : []) : r if strcontains(r, "action-token")]])) == 0
    error_message = "notifications: IAM on the Brevo key only"
  }
  assert {
    condition     = join(",", [for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "EMAIL_FROM_NAME"]) == "Стефанія Бень"
    error_message = "notifications: sender name"
  }
}

run "marketing_without_test_recipients" {
  command = plan
  variables {
    enable_booking_notifications     = false
    enable_marketing_subscription    = true
    notification_recipient_allowlist = []
  }
  expect_failures = [aws_ecs_task_definition.api]
}

run "marketing_only" {
  command = plan
  variables {
    enable_booking_notifications  = false
    enable_marketing_subscription = true
  }
  assert {
    condition     = join(",", sort([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name])) == "ACTION_TOKEN_SECRET,BREVO_API_KEY,DATABASE_URL,FIREBASE_SERVICE_ACCOUNT_JSON"
    error_message = "marketing: BREVO_API_KEY and ACTION_TOKEN_SECRET"
  }
  assert {
    condition     = join(",", [for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "FRONTEND_URL"]) == "https://massage-e9zb.vercel.app"
    error_message = "marketing: FRONTEND_URL is the stable frontend"
  }
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e if e.name == "ENABLE_BOOKING_NOTIFICATIONS"]) == 0
    error_message = "marketing: notifications stay off"
  }
  assert {
    condition     = join(",", [for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "MARKETING_RECIPIENT_ALLOWLIST"]) == "studio@example.invalid,test@example.invalid"
    error_message = "marketing on staging: only the approved test addresses"
  }
}

run "both_on" {
  command = plan
  variables {
    enable_booking_notifications  = true
    enable_marketing_subscription = true
  }
  assert {
    condition     = length([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s if s.name == "BREVO_API_KEY"]) == 1
    error_message = "both on: one BREVO_API_KEY"
  }
  assert {
    condition     = length([for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e if e.name == "EMAIL_FROM_EMAIL"]) == 1
    error_message = "both on: one sender"
  }
  assert {
    condition     = length(flatten([for st in data.aws_iam_policy_document.booking_execution["api"].statement : [for r in(st.sid == "ReadOwnSecrets" ? st.resources : []) : r if strcontains(r, "brevo-api-key")]])) == 1
    error_message = "both on: IAM on the Brevo key once"
  }
}
