# Native Terraform tests of the labs host isolation (D-43, ADR 0027): subnets, security group egress allowlist, network ACL order, metadata, user data.
# No credentials: the aws provider is mocked. Run: terraform test   (in infra/terraform/aws, after terraform init -backend=false)
mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = {
      insecure_value = "ami-0123456789abcdef0"
      value          = "ami-0123456789abcdef0"
    }
  }
}

variables {
  budget_email     = "owner@example.invalid"
  ssh_source_cidrs = ["198.51.100.7/32", "203.0.113.0/24"]
  ssh_public_keys  = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest tester"]
}

run "the_two_hosts_sit_in_different_subnets_inside_the_vpc" {
  command = apply

  assert {
    condition     = aws_subnet.p.cidr_block != aws_subnet.i.cidr_block && aws_subnet.p.id != aws_subnet.i.id
    error_message = "subnet-p and subnet-i must differ"
  }

  assert {
    condition     = cidrsubnet(aws_vpc.main.cidr_block, 8, tonumber(split(".", cidrhost(aws_subnet.i.cidr_block, 0))[2])) == aws_subnet.i.cidr_block && cidrsubnet(aws_vpc.main.cidr_block, 8, tonumber(split(".", cidrhost(aws_subnet.p.cidr_block, 0))[2])) == aws_subnet.p.cidr_block
    error_message = "both subnets must lie inside the VPC range"
  }

  assert {
    condition     = aws_instance.vm["vm-i"].subnet_id == aws_subnet.i.id && aws_instance.vm["vm-p"].subnet_id == aws_subnet.p.id
    error_message = "vm-p must be in subnet-p and vm-i in subnet-i"
  }
}

run "labs_host_egress_is_exactly_the_allowlist_and_never_protocol_minus_one" {
  command = apply

  assert {
    condition = toset([
      for k, r in aws_vpc_security_group_egress_rule.common : "${r.ip_protocol}:${r.from_port}:${r.cidr_ipv4}"
      if r.security_group_id == aws_security_group.vm["vm-i"].id
    ]) == toset(["tcp:443:0.0.0.0/0", "tcp:80:0.0.0.0/0", "tcp:53:10.0.0.2/32", "udp:53:10.0.0.2/32", "udp:123:169.254.169.123/32"])
    error_message = "the labs host egress list is not exactly https, apt http, dns tcp and udp to the VPC resolver, ntp"
  }

  assert {
    condition = alltrue([
      for r in concat(values(aws_vpc_security_group_egress_rule.common), values(aws_vpc_security_group_egress_rule.private)) : r.ip_protocol != "-1"
    ])
    error_message = "no host may have an all-protocol egress rule"
  }

  assert {
    condition     = length([for k, r in aws_vpc_security_group_egress_rule.private : k if r.security_group_id == aws_security_group.vm["vm-i"].id]) == 1
    error_message = "the labs host must have exactly one egress rule that reaches another security group"
  }

  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_egress_rule.private :
      r.referenced_security_group_id == aws_security_group.vm["vm-p"].id && r.ip_protocol == "tcp" && r.from_port == 9444 && r.to_port == 9444 && r.cidr_ipv4 == null
      if r.security_group_id == aws_security_group.vm["vm-i"].id
    ])
    error_message = "the labs host may reach vm-p only on tcp 9444 through the vm-p security group"
  }

  assert {
    condition     = length(aws_vpc_security_group_egress_rule.common) == 10 && length(aws_vpc_security_group_egress_rule.private) == 2
    error_message = "expected 5 common rules per host plus 1 private rule per host"
  }
}

run "apt_http_can_be_switched_off_and_the_list_is_then_the_strict_allowlist" {
  command = apply
  variables {
    apt_http_egress = false
  }

  assert {
    condition = toset([
      for k, r in aws_vpc_security_group_egress_rule.common : "${r.ip_protocol}:${r.from_port}:${r.cidr_ipv4}"
      if r.security_group_id == aws_security_group.vm["vm-i"].id
    ]) == toset(["tcp:443:0.0.0.0/0", "tcp:53:10.0.0.2/32", "udp:53:10.0.0.2/32", "udp:123:169.254.169.123/32"])
    error_message = "without apt http the labs egress must be 443, dns and ntp only"
  }

  assert {
    condition     = alltrue([for k, r in aws_network_acl_rule.main : r.from_port != 80 || !r.egress])
    error_message = "no outbound port 80 network ACL rule may remain"
  }
}

run "the_labs_nacl_denies_the_vpc_range_before_any_allow_to_the_internet" {
  command = apply

  assert {
    condition     = aws_network_acl_rule.main["i/out/150"].rule_action == "deny" && aws_network_acl_rule.main["i/out/150"].cidr_block == aws_vpc.main.cidr_block && aws_network_acl_rule.main["i/out/150"].protocol == "-1" && aws_network_acl_rule.main["i/out/150"].egress
    error_message = "subnet-i outbound rule 150 must deny the whole VPC range"
  }

  assert {
    condition = alltrue([
      for k, r in aws_network_acl_rule.main : r.rule_number > aws_network_acl_rule.main["i/out/150"].rule_number
      if startswith(k, "i/out/") && r.cidr_block == "0.0.0.0/0"
    ])
    error_message = "every outbound allow to the internet must be numbered after the VPC deny"
  }

  assert {
    condition     = length([for k, r in aws_network_acl_rule.main : k if startswith(k, "i/out/") && r.cidr_block == "0.0.0.0/0" && r.from_port == 443]) == 1
    error_message = "expected exactly one outbound 443 allow on subnet-i"
  }

  assert {
    condition     = length([for k, r in aws_network_acl_rule.main : k if startswith(k, "i/out/") && r.rule_action == "allow" && r.from_port == 9444 && r.cidr_block == aws_subnet.p.cidr_block]) == 1
    error_message = "subnet-i must be allowed to reach subnet-p on 9444 (numbered before the VPC deny)"
  }

  assert {
    condition = alltrue([
      for k, r in aws_network_acl_rule.main : r.rule_number < aws_network_acl_rule.main["i/out/150"].rule_number
      if startswith(k, "i/out/") && (r.from_port == 9444 || r.from_port == 53)
    ])
    error_message = "the 9444 and dns allows must come before the VPC deny"
  }

  assert {
    condition     = length([for k, r in aws_network_acl_rule.main : k if startswith(k, "i/in/") && r.from_port == 9443 && r.cidr_block == aws_subnet.p.cidr_block]) == 1
    error_message = "subnet-i must accept 9443 from subnet-p only"
  }

  assert {
    condition     = alltrue([for k, r in aws_network_acl_rule.main : r.cidr_block != "0.0.0.0/0" || r.from_port == null || r.from_port == 443 || r.from_port == 80 || r.from_port == 1024 || !startswith(k, "i/")])
    error_message = "subnet-i has an allow to or from the whole internet on a port other than 443, 80 or the reply range"
  }

  assert {
    condition     = alltrue([for k, r in aws_network_acl_rule.main : r.cidr_block != "0.0.0.0/0" || !startswith(k, "i/in/") || r.from_port == 1024 || r.protocol == "1"])
    error_message = "subnet-i inbound from the whole internet may only be the reply range and path MTU"
  }
}

run "the_platform_nacl_takes_the_ingest_port_from_subnet_i_and_the_public_ports_from_the_listed_sources" {
  command = apply

  assert {
    condition     = length([for k, r in aws_network_acl_rule.main : k if startswith(k, "p/in/") && r.from_port == 9444 && r.cidr_block == aws_subnet.i.cidr_block]) == 1
    error_message = "subnet-p must accept 9444 from subnet-i"
  }

  assert {
    condition = alltrue([
      for k, r in aws_network_acl_rule.main : contains(concat(var.ssh_source_cidrs, [aws_subnet.i.cidr_block, "0.0.0.0/0"]), r.cidr_block)
      if startswith(k, "p/in/")
    ])
    error_message = "subnet-p inbound has a source outside the listed addresses, subnet-i and the reply range"
  }

  assert {
    condition     = length(aws_network_acl.main) == 2 && aws_network_acl.main["i"].subnet_ids != aws_network_acl.main["p"].subnet_ids
    error_message = "each subnet has its own network ACL"
  }
}

run "metadata_is_imdsv2_one_hop" {
  command = apply

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : i.metadata_options[0].http_tokens == "required" && i.metadata_options[0].http_put_response_hop_limit == 1])
    error_message = "IMDSv2 required and hop limit 1 on every host"
  }
}

run "user_data_contains_no_secret_pattern_and_the_egress_files" {
  command = plan

  assert {
    condition     = !can(regex("AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY|ASIA[0-9A-Z]{16}", local.user_data_raw))
    error_message = "the user data contains something that looks like a key"
  }

  assert {
    condition     = strcontains(local.user_data_raw, "LABS_HOST_SUBNET=10.0.1.0/24") && strcontains(local.user_data_raw, "VPC_RESOLVER=10.0.0.2") && strcontains(local.user_data_raw, "INGEST_PORT=9444")
    error_message = "the egress settings must reach the host (labs subnet, resolver, ingest port)"
  }

  assert {
    condition     = local.user_data_bytes <= 16384
    error_message = "user data is larger than 16384 bytes"
  }
}