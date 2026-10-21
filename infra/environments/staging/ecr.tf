# Two private repositories for the two targets of services/booking/Dockerfile:
# runtime (API) and migrate (one-off migration task). Separate repositories
# keep IAM pull permissions, scan results and lifecycle per image type.
# Images are tagged with the git commit SHA; tags are immutable, so a tag
# always points to the same image and older tags remain available for
# rollback.
#
# The repositories are NOT staging-specific: one image is built once, tested
# in staging and promoted to production by digest, without a rebuild.
# Production will use these repositories instead of creating its own. They
# are managed in this root for now; moving them to a shared root later is a
# state move, not a re-creation.

locals {
  ecr_repositories = {
    booking_api     = "${var.ecr_namespace}/booking-api"
    booking_migrate = "${var.ecr_namespace}/booking-migrate"
  }

  # Only untagged images (e.g. leftovers of failed pushes) expire. Tagged
  # images are never removed automatically. Images referenced by a manifest
  # list are not expired while the list exists.
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images older than ${var.ecr_untagged_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.ecr_untagged_expiry_days
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_repository" "booking" {
  for_each = local.ecr_repositories

  name = each.value
  # Shared with production: override the provider default tag.
  tags = {
    Environment = "shared"
  }

  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  # Basic scanning on push (repository setting). Enhanced scanning is a
  # registry-level option and is not enabled here.
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "booking" {
  for_each = aws_ecr_repository.booking

  repository = each.value.name
  policy     = local.ecr_lifecycle_policy
}
