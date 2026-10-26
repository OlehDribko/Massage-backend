# Public HTTPS entry point without an own domain and without an ALB:
#
#   client ──HTTPS──▶ API Gateway HTTP API (https://<api-id>.execute-api.<region>.amazonaws.com)
#                       │ private integration, VPC link V2 (ENIs in the VPC)
#                       ▼ HTTP inside the VPC, port app_port, SG vpc_link → SG api
#                     ECS task, discovered via Cloud Map (SRV: IP + port)
#
# - TLS terminates at API Gateway with an AWS-managed certificate for the
#   execute-api name; the hop to the task stays inside the VPC.
# - HTTP APIs have no response cache; every request reaches the service.
# - Authorization is a reserved header: forwarded unchanged, never mapped.
# - Requests are throttled on the $default route; integration timeout 30 s
#   (the HTTP API maximum).
# - VPC links V2 exist only in some AZs of eu-west-3 (euw3-az1, euw3-az3), so
#   the link uses only the public subnets there; tasks may run in any subnet.
# - A VPC link without traffic for 60 days turns INACTIVE; the first request
#   after that fails until API Gateway re-creates its interfaces (minutes).

locals {
  vpc_link_subnet_ids = [
    for zone in var.availability_zones : aws_subnet.public[zone].id
    if contains(var.vpc_link_az_ids, aws_subnet.public[zone].availability_zone_id)
  ]
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${var.name_prefix}.internal"
  description = "Service discovery for ${var.name_prefix} (API Gateway private integration)"
  vpc         = aws_vpc.main.id
}

# API Gateway needs IP and port of each instance, hence SRV records.
# Instance health comes from the ECS container health check.
# failure_threshold is deprecated (AWS always uses 1), but an empty block is
# not sent to AWS at all: the service is then created without a custom health
# check and every later plan wants to replace it. Setting the value sends it.
resource "aws_service_discovery_service" "api" {
  name = "booking-api"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "SRV"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_apigatewayv2_vpc_link" "api" {
  name               = "${var.name_prefix}-booking-api"
  subnet_ids         = local.vpc_link_subnet_ids
  security_group_ids = [aws_security_group.vpc_link.id]

  lifecycle {
    precondition {
      condition     = length(local.vpc_link_subnet_ids) > 0
      error_message = "No public subnet is in an AZ that supports VPC links V2 (vpc_link_az_ids)."
    }
  }
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${var.name_prefix}-booking-api"
  description   = "Booking API (staging): HTTPS entry point, private integration to ECS"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.api.id
  integration_uri        = aws_service_discovery_service.api.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/apigateway/${var.name_prefix}/booking-api"
  retention_in_days = var.log_retention_days
}

# $default stage: no stage name in the URL or in the path sent to the service.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.api_throttling_rate_limit
    throttling_burst_limit = var.api_throttling_burst_limit
  }

  # No headers, query strings or bodies in access logs.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      requestTime      = "$context.requestTime"
      sourceIp         = "$context.identity.sourceIp"
      httpMethod       = "$context.httpMethod"
      path             = "$context.path"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      latencyMs        = "$context.responseLatency"
      integrationMs    = "$context.integrationLatency"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}
