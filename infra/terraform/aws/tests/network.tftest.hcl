# Native Terraform tests of the firewall rules, host wiring and input checks. No credentials: the aws provider is mocked.
# Run: terraform test   (in infra/terraform/aws, after terraform init)
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

run "public_ingress_is_22_80_443_only_and_closed_to_the_internet_by_default" {
  command = apply

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.public : contains([22, 80, 443], r.from_port)])
    error_message = "a public rule uses a port other than 22, 80 or 443"
  }

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.public : r.from_port == r.to_port && r.ip_protocol == "tcp"])
    error_message = "a public rule is a port range or not tcp"
  }

  # Default: 80 and 443 follow the SSH list, so nothing is open to the internet.
  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_ingress_rule.public :
      contains(var.ssh_source_cidrs, r.cidr_ipv4 != null ? r.cidr_ipv4 : r.cidr_ipv6)
    ])
    error_message = "a public rule is open to an address that is not in ssh_source_cidrs while public_web_cidrs is not set"
  }

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.public : r.cidr_ipv4 != "0.0.0.0/0"])
    error_message = "0.0.0.0/0 appears without public_web_cidrs being set on purpose"
  }

  # 2 hosts x 2 listed addresses, for each of the ports 22, 80 and 443.
  assert {
    condition     = length([for k, r in aws_vpc_security_group_ingress_rule.public : k if r.from_port == 22]) == 4
    error_message = "expected 4 ssh rules (2 hosts x 2 source addresses)"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.public) == 12
    error_message = "expected 12 public rules in total (3 ports x 2 hosts x 2 addresses)"
  }
}

run "web_ports_open_to_the_internet_only_when_set_on_purpose" {
  command = apply
  variables {
    public_web_cidrs = ["0.0.0.0/0"]
  }

  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_ingress_rule.public :
      r.from_port == 22 ? contains(var.ssh_source_cidrs, r.cidr_ipv4) : r.cidr_ipv4 == "0.0.0.0/0"
    ])
    error_message = "22 must stay on the SSH list; 80 and 443 must be open to 0.0.0.0/0 when public_web_cidrs says so"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.public) == 8
    error_message = "expected 8 public rules (4 ssh, 2 hosts x 80 and 443 once each)"
  }
}

run "an_ipv6_source_does_not_crash_the_assertions_and_uses_cidr_ipv6" {
  command = apply
  variables {
    ssh_source_cidrs = ["198.51.100.7/32", "2001:db8:1::/48"]
  }

  assert {
    condition     = length([for k, r in aws_vpc_security_group_ingress_rule.public : k if r.cidr_ipv6 != null && r.cidr_ipv4 == null]) == 6
    error_message = "the IPv6 source must become a cidr_ipv6 rule (3 ports x 2 hosts)"
  }

  assert {
    condition = alltrue([
      for k, r in aws_vpc_security_group_ingress_rule.public :
      contains(var.ssh_source_cidrs, r.cidr_ipv4 != null ? r.cidr_ipv4 : r.cidr_ipv6)
    ])
    error_message = "a public rule source is not in the list"
  }
}

run "ssh_token_is_expanded" {
  command = apply

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.public : r.cidr_ipv4 != "$ssh_source_cidrs" && r.cidr_ipv4 != "$public_web_cidrs"])
    error_message = "a source token was not expanded to the listed addresses"
  }

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.public : r.cidr_ipv4 == null || can(cidrhost(r.cidr_ipv4, 0))])
    error_message = "a public rule source is not a CIDR"
  }
}
run "private_rules_sit_on_the_to_side_with_the_from_side_as_source" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.private["orchestrator-mtls"].security_group_id == aws_security_group.vm["vm-i"].id
    error_message = "orchestrator-mtls must be on the vm-i group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.private["orchestrator-mtls"].referenced_security_group_id == aws_security_group.vm["vm-p"].id
    error_message = "orchestrator-mtls source must be the vm-p group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.private["ingest-internal"].security_group_id == aws_security_group.vm["vm-p"].id
    error_message = "ingest-internal must be on the vm-p group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.private["ingest-internal"].referenced_security_group_id == aws_security_group.vm["vm-i"].id
    error_message = "ingest-internal source must be the vm-i group"
  }

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.private : r.cidr_ipv4 == null && r.cidr_ipv6 == null])
    error_message = "private rules must name a security group, never an address range"
  }

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.private : r.from_port == r.to_port && r.ip_protocol == "tcp"])
    error_message = "a private rule is a port range or not tcp"
  }
}

run "only_path_mtu_icmp_and_the_default_group_is_empty" {
  command = apply

  assert {
    condition     = alltrue([for k, r in aws_vpc_security_group_ingress_rule.icmp : r.ip_protocol == "icmp" && r.from_port == 3 && r.to_port == 4])
    error_message = "the only ICMP rule is type 3 code 4 (path MTU discovery)"
  }

  assert {
    condition     = length(aws_default_security_group.main.ingress) == 0 && length(aws_default_security_group.main.egress) == 0
    error_message = "the VPC default security group must have no rules"
  }
}

run "hosts_use_imdsv2_one_hop_encrypted_gp3_and_the_eligible_defaults" {
  command = apply

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : i.metadata_options[0].http_tokens == "required"])
    error_message = "IMDSv2 must be required on every host"
  }

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : i.metadata_options[0].http_put_response_hop_limit == 1])
    error_message = "the metadata hop limit must be 1 so containers cannot read it"
  }

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : i.metadata_options[0].http_endpoint == "enabled"])
    error_message = "the metadata endpoint should stay enabled (cloud-init needs it)"
  }

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : i.root_block_device[0].volume_type == "gp3" && i.root_block_device[0].encrypted])
    error_message = "root disks must be encrypted gp3"
  }

  assert {
    condition     = aws_instance.vm["vm-p"].instance_type == "t3.small" && aws_instance.vm["vm-i"].instance_type == "m7i-flex.large"
    error_message = "default sizes are t3.small (platform) and m7i-flex.large (labs)"
  }

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : contains(["t3.micro", "t3.small", "t4g.micro", "t4g.small", "c7i-flex.large", "m7i-flex.large"], i.instance_type)])
    error_message = "a host uses a type that is not Free Plan eligible"
  }

  assert {
    condition     = alltrue([for k, i in aws_instance.vm : length(i.vpc_security_group_ids) == 1])
    error_message = "each host has exactly its own security group"
  }
}

run "each_host_has_an_elastic_ip" {
  command = apply

  assert {
    condition     = length(aws_eip.vm) == 2 && alltrue([for k, e in aws_eip.vm : e.domain == "vpc"])
    error_message = "both hosts need an Elastic IP so the address survives stop and start"
  }
}

run "arm_type_picks_the_arm_image" {
  command = plan
  variables {
    instance_types = { "vm-p" = "t4g.small", "vm-i" = "t4g.small" }
  }

  assert {
    condition     = toset(keys(data.aws_ssm_parameter.ubuntu)) == toset(["arm64"])
    error_message = "t4g types must read the arm64 image parameter only"
  }
}

run "keepalive_is_off_by_default_and_can_be_turned_on" {
  command = plan

  assert {
    condition     = strcontains(local.user_data, "\" \"no\"")
    error_message = "keep-alive must be off by default"
  }
}

run "keepalive_on_is_passed_to_the_baseline" {
  command = plan
  variables {
    keepalive_enabled = true
  }

  assert {
    condition     = strcontains(local.user_data, "\" \"yes\"")
    error_message = "keepalive_enabled = true must reach the baseline script"
  }
}

run "user_data_is_within_the_size_limit" {
  command = plan

  assert {
    condition     = local.user_data_bytes <= 16384
    error_message = "user data is larger than 16384 bytes"
  }
}

run "ineligible_instance_type_is_refused" {
  command = plan
  variables {
    instance_types = { "vm-p" = "t3.small", "vm-i" = "m5.large" }
  }
  expect_failures = [var.instance_types]
}

run "instance_types_need_both_hosts" {
  command = plan
  variables {
    instance_types = { "vm-p" = "t3.small" }
  }
  expect_failures = [var.instance_types]
}

run "other_region_is_refused" {
  command = plan
  variables {
    region = "ap-south-1"
  }
  expect_failures = [var.region]
}

run "wide_ssh_source_is_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["10.0.0.0/8"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "open_ssh_source_is_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "ipv6_everywhere_is_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["::/0"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "placeholder_and_duplicate_sources_are_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["PASTE-YOUR-ADDRESS/32", "198.51.100.7/32", "198.51.100.7/32"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "private_key_and_placeholder_keys_are_refused" {
  command = plan
  variables {
    ssh_public_keys = ["ssh-ed25519 AAAA... tanmay", "BEGIN OPENSSH PRIVATE KEY"]
  }
  expect_failures = [var.ssh_public_keys]
}

run "disk_size_out_of_range_is_refused" {
  command = plan
  variables {
    root_volume_gb = 500
  }
  expect_failures = [var.root_volume_gb]
}

run "user_data_carries_every_developer_key_and_the_amazon_time_server" {
  command = plan
  variables {
    ssh_public_keys = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkeyone one", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkeytwo two", "ssh-rsa AAAAB3NzaC1yc2EAAAAkeythree three"]
  }

  assert {
    condition     = alltrue([for k in var.ssh_public_keys : strcontains(local.user_data, k)])
    error_message = "every public key must be in the cloud-init user data"
  }

  assert {
    condition     = strcontains(local.user_data, "NTP=169.254.169.123")
    error_message = "the Amazon Time Sync address must be the NTP server"
  }
}

run "user_data_size_counts_bytes" {
  command = plan

  assert {
    condition     = local.user_data_bytes > 0 && local.user_data_bytes < length(local.user_data_raw) && local.user_data_bytes <= 16384
    error_message = "the compressed user data must be smaller than the text and within the limit"
  }
}

run "labs_host_is_running_by_default" {
  command = apply

  assert {
    condition     = aws_ec2_instance_state.vm_i.state == "running"
    error_message = "vm-i must be running by default"
  }
}

run "vm_i_running_false_stops_the_labs_host" {
  command = apply
  variables {
    vm_i_running = false
  }

  assert {
    condition     = aws_ec2_instance_state.vm_i.state == "stopped"
    error_message = "vm_i_running = false must stop the labs host"
  }
}

run "ipv6_only_ssh_list_is_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["2001:db8:1::/48"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "non_canonical_cidr_is_refused" {
  command = plan
  variables {
    ssh_source_cidrs = ["198.51.100.7/24"]
  }
  expect_failures = [var.ssh_source_cidrs]
}

run "public_web_cidrs_must_be_valid" {
  command = plan
  variables {
    public_web_cidrs = ["10.0.0.0/8"]
  }
  expect_failures = [var.public_web_cidrs]
}

run "monthly_budget_above_the_credit_is_refused" {
  command = plan
  variables {
    monthly_budget_usd = 500
  }
  expect_failures = [var.monthly_budget_usd]
}

run "key_pair_does_not_depend_on_list_order" {
  command = plan
  variables {
    ssh_public_keys = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIzzz zed", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIaaa aye"]
  }

  assert {
    condition     = local.key_pair_public_key == "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIaaa aye"
    error_message = "the key pair must use the first key of the sorted list"
  }
}