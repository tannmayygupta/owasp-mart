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

  # D-43: the platform host and the labs host sit in two different subnets.
  subnet_cidr_of = { "vm-p" = local.rules.subnet_p_cidr, "vm-i" = local.rules.subnet_i_cidr }
  resolver_cidr  = "${cidrhost(local.rules.vcn_cidr, 2)}/32" # the VPC resolver is the VPC base address plus 2
  timesync_cidr  = "169.254.169.123/32"                      # Amazon Time Sync Service
  eph            = local.rules.ephemeral_ports

  # Outbound allowlist shared by both hosts (network-rules.json egress_common); apt-http only while var.apt_http_egress is true.
  egress_common = { for r in local.rules.egress_common : r.name => r if !try(r.optional, false) || var.apt_http_egress }
  egress_pairs = {
    for pair in setproduct(local.vm_names, keys(local.egress_common)) :
    "${pair[0]}/${pair[1]}" => { vm = pair[0], rule = local.egress_common[pair[1]] }
  }

  private_list = [for k in sort(keys(local.private_rules)) : local.private_rules[k]]

  # Source addresses per public rule (IPv4 only: the VPC has no IPv6), for the network ACLs.
  public_sources_v4 = {
    for r in local.rules.public_ingress : r.name => sort(distinct([
      for s in flatten([for x in r.sources : x == "$ssh_source_cidrs" ? var.ssh_source_cidrs : (x == "$public_web_cidrs" ? local.web_cidrs : [x])]) : s if !strcontains(s, ":")
    ]))
  }
  reply_sources_v4 = sort(distinct(flatten(values(local.public_sources_v4))))

  # Network ACL entries. Stateless: replies need their own rules (ephemeral ports). "internet" stands for the whole IPv4 range and is
  # expanded inside the rule resource. Numbers: lower number wins, so the deny of the VPC range (150) sits before every allow to the internet (200 and up).
  nd = { acl = null, egress = false, number = 0, action = "allow", protocol = "6", cidr = "internet", from = null, to = null, icmp_type = null, icmp_code = null }

  nacl_public_in = flatten([
    for ri, r in local.rules.public_ingress : [
      for si, s in local.public_sources_v4[r.name] : { number = 100 * (ri + 1) + si, cidr = s, port = r.port }
    ]
  ])

  nacl_entries = concat(
    # subnet-i (labs) inbound: the public ports from the listed sources, the orchestrator port from subnet-p, replies, path MTU.
    [for e in local.nacl_public_in : merge(local.nd, { acl = "i", number = e.number, cidr = e.cidr, from = e.port, to = e.port })],
    [for i, r in local.private_list : merge(local.nd, { acl = "i", number = 500 + i, cidr = local.rules.subnet_p_cidr, from = r.port, to = r.port }) if r.to == "vm-i"],
    [merge(local.nd, { acl = "i", number = 600, from = local.eph.from, to = local.eph.to })],
    [merge(local.nd, { acl = "i", number = 610, protocol = "17", from = local.eph.from, to = local.eph.to })],
    [merge(local.nd, { acl = "i", number = 620, protocol = "1", icmp_type = 3, icmp_code = 4 })],
    # subnet-i outbound: replies to subnet-p, the ingest port, the resolver, then DENY the rest of the VPC, then the internet allowlist.
    [merge(local.nd, { acl = "i", egress = true, number = 90, cidr = local.rules.subnet_p_cidr, from = local.eph.from, to = local.eph.to })],
    [for i, r in local.private_list : merge(local.nd, { acl = "i", egress = true, number = 100 + i, cidr = local.rules.subnet_p_cidr, from = r.port, to = r.port }) if r.from == "vm-i"],
    [for ci, r in local.rules.egress_common : merge(local.nd, { acl = "i", egress = true, number = 110 + ci, cidr = local.resolver_cidr, protocol = r.protocol == "udp" ? "17" : "6", from = r.port, to = r.port }) if r.to == "vpc-resolver"],
    [merge(local.nd, { acl = "i", egress = true, number = 150, action = "deny", protocol = "-1", cidr = local.rules.vcn_cidr })],
    [for ci, r in local.rules.egress_common : merge(local.nd, { acl = "i", egress = true, number = 200 + ci, protocol = r.protocol == "udp" ? "17" : "6", from = r.port, to = r.port }) if r.to == "internet" && contains(keys(local.egress_common), r.name)],
    [for ci, r in local.rules.egress_common : merge(local.nd, { acl = "i", egress = true, number = 250 + ci, cidr = local.timesync_cidr, protocol = r.protocol == "udp" ? "17" : "6", from = r.port, to = r.port }) if r.to == "time-sync"],
    [for si, s in local.reply_sources_v4 : merge(local.nd, { acl = "i", egress = true, number = 300 + si, cidr = s, from = local.eph.from, to = local.eph.to })],
    # subnet-p (platform) inbound: the public ports, the ingest port from subnet-i, replies, path MTU. Outbound: open here; the security group egress list is the filter.
    [for e in local.nacl_public_in : merge(local.nd, { acl = "p", number = e.number, cidr = e.cidr, from = e.port, to = e.port })],
    [for i, r in local.private_list : merge(local.nd, { acl = "p", number = 500 + i, cidr = local.rules.subnet_i_cidr, from = r.port, to = r.port }) if r.to == "vm-p"],
    [merge(local.nd, { acl = "p", number = 600, from = local.eph.from, to = local.eph.to })],
    [merge(local.nd, { acl = "p", number = 610, protocol = "17", from = local.eph.from, to = local.eph.to })],
    [merge(local.nd, { acl = "p", number = 620, protocol = "1", icmp_type = 3, icmp_code = 4 })],
    [merge(local.nd, { acl = "p", egress = true, number = 100, protocol = "-1" })],
  )
}

moved {
  from = aws_subnet.main
  to   = aws_subnet.p
}

moved {
  from = aws_route_table.main
  to   = aws_route_table.p
}

moved {
  from = aws_route_table_association.main
  to   = aws_route_table_association.p
}

moved {
  from = aws_vpc_security_group_egress_rule.all
  to   = aws_vpc_security_group_egress_rule.common
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

# Two public subnets (D-43): subnet-p for the platform host, subnet-i for the labs host. No NAT gateway: it costs about USD 0.045 per hour,
# so both subnets route straight to the internet gateway and the labs host is held back by security groups, network ACLs and host rules.
resource "aws_subnet" "p" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.rules.subnet_p_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "vulnmart-subnet-p" }
}

resource "aws_subnet" "i" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.rules.subnet_i_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = { Name = "vulnmart-subnet-i" }
}

resource "aws_route_table" "p" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "vulnmart-routes-p" }
}

resource "aws_route_table" "i" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "vulnmart-routes-i" }
}

resource "aws_route_table_association" "p" {
  subnet_id      = aws_subnet.p.id
  route_table_id = aws_route_table.p.id
}

resource "aws_route_table_association" "i" {
  subnet_id      = aws_subnet.i.id
  route_table_id = aws_route_table.i.id
}

# Network ACLs (stateless). Entries come from local.nacl_entries. A root or privileged container can bypass host filters; this layer
# and the security groups are the real boundary. NACLs cannot filter 169.254.169.254 (link-local): the metadata hop limit and the host rules cover that.
resource "aws_network_acl" "main" {
  for_each   = { p = aws_subnet.p.id, i = aws_subnet.i.id }
  vpc_id     = aws_vpc.main.id
  subnet_ids = [each.value]

  tags = { Name = "vulnmart-nacl-${each.key}" }
}

resource "aws_network_acl_rule" "main" {
  for_each       = { for e in local.nacl_entries : "${e.acl}/${e.egress ? "out" : "in"}/${e.number}" => e }
  network_acl_id = aws_network_acl.main[each.value.acl].id
  rule_number    = each.value.number
  egress         = each.value.egress
  rule_action    = each.value.action
  protocol       = each.value.protocol
  cidr_block     = each.value.cidr == "internet" ? "0.0.0.0/0" : each.value.cidr
  from_port      = each.value.from
  to_port        = each.value.to
  icmp_type      = each.value.icmp_type
  icmp_code      = each.value.icmp_code
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

# Egress (D-43): an allowlist per host, never "all outbound". Common rules come from network-rules.json egress_common; the private rules
# (the same file, private_ingress) are also outbound rules on the from-side host: vm-p to vm-i on the orchestrator port, vm-i to vm-p on the ingest port only.
# SECURITY GROUPS CANNOT filter 169.254.169.254 (instance metadata) or, in practice, the VPC resolver: see the host rules and the metadata hop limit.
resource "aws_vpc_security_group_egress_rule" "common" {
  for_each          = local.egress_pairs
  security_group_id = aws_security_group.vm[each.value.vm].id
  ip_protocol       = each.value.rule.protocol
  from_port         = each.value.rule.port
  to_port           = each.value.rule.port
  cidr_ipv4         = each.value.rule.to == "internet" ? "0.0.0.0/0" : (each.value.rule.to == "vpc-resolver" ? local.resolver_cidr : local.timesync_cidr)
  description       = each.value.rule.name
}

resource "aws_vpc_security_group_egress_rule" "private" {
  for_each                     = local.private_rules
  security_group_id            = aws_security_group.vm[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = aws_security_group.vm[each.value.to].id
  description                  = "${each.value.name} (outbound)"
}