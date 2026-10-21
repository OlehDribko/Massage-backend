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
