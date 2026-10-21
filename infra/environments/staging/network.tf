# Staging network: one VPC, two public subnets in different AZs, an Internet
# Gateway. No NAT Gateway, Elastic IPs or VPC endpoints: future Fargate tasks
# get a public IP (assign_public_ip in the ECS service) to reach ECR,
# CloudWatch Logs, Neon, Brevo and Firebase. "Public subnet" only means a
# route to the Internet Gateway; inbound access is decided by security groups.

locals {
  public_subnets = {
    for index, zone in var.availability_zones : zone => {
      cidr_block = cidrsubnet(var.vpc_cidr, 8, index)
      name       = "${var.name_prefix}-public-${zone}"
    }
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

# The VPC's default security group keeps no rules, so nothing can use it by
# accident (resources must reference the explicit groups below).
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-default-unused"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value.cidr_block

  # No automatic public IPs: only resources that explicitly request one
  # (the future ECS service) get it.
  map_public_ip_on_launch = false

  tags = {
    Name = each.value.name
    Tier = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}
