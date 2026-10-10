locals {
  rules = jsondecode(file("${path.module}/../../network-rules.json"))

  # One flat entry per (rule, source address). "$ssh_source_cidrs" expands to the variable.
  public_flat = flatten([
    for r in local.rules.public_ingress : [
      for s in flatten([for x in r.sources : x == "$ssh_source_cidrs" ? var.ssh_source_cidrs : (x == "$public_web_cidrs" ? local.web_cidrs : [x])]) : {
        name   = r.name
        port   = r.port
        source = s
      }
    ]
  ])
  public_rules = { for r in local.public_flat : "${r.name}-${r.port}-${r.source}" => r }

  # Ports 80 and 443 follow public_web_cidrs; without it they follow the SSH list (nothing is open to the internet).
  web_cidrs = var.public_web_cidrs == null ? var.ssh_source_cidrs : var.public_web_cidrs

  private_rules = { for r in local.rules.private_ingress : r.name => r }

  vm_names = ["vm-p", "vm-i"]
}

resource "aws_vpc" "main" {
  cidr_block           = local.rules.vcn_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "vulnmart-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "vulnmart-igw" }
}

# One public subnet for both hosts (no NAT gateway: it costs about USD 0.045 per hour).
resource "aws_subnet" "main" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.rules.subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "vulnmart-subnet" }
}

resource "aws_route_table" "main" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "vulnmart-routes" }
}

resource "aws_route_table_association" "main" {
  subnet_id      = aws_subnet.main.id
  route_table_id = aws_route_table.main.id
}

# The VPC default group is emptied: no ingress and no egress. Hosts use their own groups below.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "vulnmart-default-closed" }
}

resource "aws_security_group" "vm" {
  for_each    = toset(local.vm_names)
  name        = "vulnmart-${each.key}"
  description = "VulnMart ${each.key}: ports from network-rules.json only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "sg-${each.key}" }
}

# Public ingress: every host gets the same list. Security groups are stateful: replies are allowed automatically.
resource "aws_vpc_security_group_ingress_rule" "public" {
  for_each = {
    for pair in setproduct(local.vm_names, keys(local.public_rules)) :
    "${pair[0]}/${pair[1]}" => { vm = pair[0], rule = local.public_rules[pair[1]] }
  }
  security_group_id = aws_security_group.vm[each.value.vm].id
  ip_protocol       = "tcp"
  from_port         = each.value.rule.port
  to_port           = each.value.rule.port
  cidr_ipv4         = strcontains(each.value.rule.source, ":") ? null : each.value.rule.source
  cidr_ipv6         = strcontains(each.value.rule.source, ":") ? each.value.rule.source : null
  description       = each.value.rule.name
}

# Private ingress: only from the other host's group, only the named port.
resource "aws_vpc_security_group_ingress_rule" "private" {
  for_each                     = local.private_rules
  security_group_id            = aws_security_group.vm[each.value.to].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = aws_security_group.vm[each.value.from].id
  description                  = each.value.name
}

# Path MTU discovery (ICMP type 3 code 4) from rules.icmp_ingress; not a port.
resource "aws_vpc_security_group_ingress_rule" "icmp" {
  for_each = {
    for pair in setproduct(local.vm_names, [for r in local.rules.icmp_ingress : r.name]) :
    "${pair[0]}/${pair[1]}" => { vm = pair[0], rule = one([for r in local.rules.icmp_ingress : r if r.name == pair[1]]) }
  }
  security_group_id = aws_security_group.vm[each.value.vm].id
  ip_protocol       = "icmp"
  from_port         = each.value.rule.type
  to_port           = each.value.rule.code
  cidr_ipv4         = "0.0.0.0/0"
  description       = each.value.rule.name
}

# Egress: the hosts pull images and certificates, so all outbound traffic is allowed.
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = toset(local.vm_names)
  security_group_id = aws_security_group.vm[each.key].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "all outbound"
}
