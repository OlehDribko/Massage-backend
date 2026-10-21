# Two private repositories for the two targets of services/booking/Dockerfile:
# runtime (API) and migrate (one-off migration task). Separate repositories
# keep IAM pull permissions, scan results and lifecycle per image type.
# Images are tagged with the git commit SHA; tags are immutable, so a tag
# always points to the same image and older tags remain available for
# rollback.

locals {
  ecr_repositories = {
    booking_api     = "${var.name_prefix}/booking-api"
    booking_migrate = "${var.name_prefix}/booking-migrate"
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

  name                 = each.value
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
