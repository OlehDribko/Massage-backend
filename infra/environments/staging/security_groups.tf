# ALB: HTTP/HTTPS from the internet; may only talk to the API port.
# API: accepts the app port from the ALB group only; no SSH, no direct
# public ingress. Egress is limited by port, not by provider IPs (Neon,
# Brevo, Firebase and AWS public endpoints use changing IP ranges).

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Future ALB: HTTP/HTTPS in, API port out to the API group only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-alb"
  }
}

resource "aws_security_group" "api" {
  name        = "${var.name_prefix}-api"
  description = "Booking API tasks: app port from the ALB only; HTTPS and PostgreSQL out"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-api"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirect to HTTPS once a certificate exists)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the booking API port"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "Booking API port from the ALB only"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

# HTTPS: ECR API and image layers (S3), CloudWatch Logs, future Secrets
# Manager/SSM, Brevo API, Firebase/Google APIs.
resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  description       = "HTTPS to AWS APIs, ECR, CloudWatch, Brevo, Firebase"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# PostgreSQL over TLS to Neon (DATABASE_SSL_MODE=verify-full in the app).
resource "aws_vpc_security_group_egress_rule" "api_postgres" {
  security_group_id = aws_security_group.api.id
  description       = "PostgreSQL (TLS) to Neon"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = "0.0.0.0/0"
}

# API Gateway VPC link: no inbound rules (API Gateway opens the connections
# from its interfaces); outbound only to the API port of the API group.
resource "aws_security_group" "vpc_link" {
  name        = "${var.name_prefix}-vpc-link"
  description = "API Gateway VPC link: API port out to the API group only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-vpc-link"
  }
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_api" {
  security_group_id            = aws_security_group.vpc_link.id
  description                  = "Forward to the booking API port"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_vpc_link" {
  security_group_id            = aws_security_group.api.id
  description                  = "Booking API port from the API Gateway VPC link only"
  ip_protocol                  = "tcp"
  from_port                    = var.app_port
  to_port                      = var.app_port
  referenced_security_group_id = aws_security_group.vpc_link.id
}

# One-off migration task: no inbound rules at all; HTTPS (ECR, CloudWatch
# Logs, SSM) and PostgreSQL (Neon) out.
resource "aws_security_group" "migrate" {
  name        = "${var.name_prefix}-migrate"
  description = "Booking migration task: no ingress; HTTPS and PostgreSQL out"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-migrate"
  }
}

resource "aws_vpc_security_group_egress_rule" "migrate_https" {
  security_group_id = aws_security_group.migrate.id
  description       = "HTTPS to ECR, CloudWatch Logs, SSM"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "migrate_postgres" {
  security_group_id = aws_security_group.migrate.id
  description       = "PostgreSQL (TLS) to Neon"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = "0.0.0.0/0"
}
