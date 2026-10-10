# Native Terraform tests of the firewall rules. No credentials: the oci provider is mocked.
# Run: terraform test   (in infra/terraform/oci, after terraform init)
mock_provider "oci" {
  mock_data "oci_identity_availability_domains" {
    defaults = {
      availability_domains = [{ name = "AD-1" }, { name = "AD-2" }]
    }
  }
  mock_data "oci_core_images" {
    defaults = {
      images = [{ id = "image-1" }]
    }
  }
}

variables {
  tenancy_ocid     = "test"
  user_ocid        = "test"
  fingerprint      = "test"
  private_key_path = "test"
  compartment_ocid = "test"
  alarm_email      = "owner@example.invalid"
  ssh_source_cidrs = ["198.51.100.7/32", "203.0.113.0/24"]
  ssh_public_keys  = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest tester"]
}

run "public_ingress_is_22_80_443_only" {
  command = apply

  assert {
    condition = alltrue([
      for k, r in oci_core_network_security_group_security_rule.public :
      contains([22, 80, 443], r.tcp_options[0].destination_port_range[0].min)
    ])
    error_message = "a public rule uses a port other than 22, 80 or 443"
  }

  assert {
    condition = alltrue([
      for k, r in oci_core_network_security_group_security_rule.public :
      r.tcp_options[0].destination_port_range[0].min == r.tcp_options[0].destination_port_range[0].max
    ])
    error_message = "a public rule is a port range"
  }

  assert {
    condition = alltrue([
      for k, r in oci_core_network_security_group_security_rule.public :
      r.tcp_options[0].destination_port_range[0].min != 22 || contains(var.ssh_source_cidrs, r.source)
    ])
    error_message = "port 22 is open to a source that is not in ssh_source_cidrs"
  }

  assert {
    condition = alltrue([
      for k, r in oci_core_network_security_group_security_rule.public :
      r.tcp_options[0].destination_port_range[0].min == 22 || r.source == "0.0.0.0/0"
    ])
    error_message = "ports 80 and 443 must be open to 0.0.0.0/0"
  }

  # 2 VMs x 2 listed addresses for SSH, plus one rule each for 80 and 443 on both VMs.
  assert {
    condition     = length([for k, r in oci_core_network_security_group_security_rule.public : k if r.tcp_options[0].destination_port_range[0].min == 22]) == 4
    error_message = "expected 4 ssh rules (2 VMs x 2 source addresses)"
  }

  assert {
    condition     = length(oci_core_network_security_group_security_rule.public) == 8
    error_message = "expected 8 public rules in total"
  }
}

run "ssh_token_is_expanded" {
  command = apply

  assert {
    condition     = alltrue([for k, r in oci_core_network_security_group_security_rule.public : r.source != "$ssh_source_cidrs"])
    error_message = "the $ssh_source_cidrs token was not expanded to the listed addresses"
  }

  assert {
    condition     = alltrue([for k, r in oci_core_network_security_group_security_rule.public : can(cidrhost(r.source, 0))])
    error_message = "a public rule source is not a CIDR"
  }
}

run "private_rules_sit_on_the_to_side_with_the_from_side_as_source" {
  command = apply

  assert {
    condition     = oci_core_network_security_group_security_rule.private["orchestrator-mtls"].network_security_group_id == oci_core_network_security_group.vm["vm-i"].id
    error_message = "orchestrator-mtls must be on the vm-i group"
  }

  assert {
    condition     = oci_core_network_security_group_security_rule.private["orchestrator-mtls"].source == oci_core_network_security_group.vm["vm-p"].id
    error_message = "orchestrator-mtls source must be the vm-p group"
  }

  assert {
    condition     = oci_core_network_security_group_security_rule.private["ingest-internal"].network_security_group_id == oci_core_network_security_group.vm["vm-p"].id
    error_message = "ingest-internal must be on the vm-p group"
  }

  assert {
    condition     = oci_core_network_security_group_security_rule.private["ingest-internal"].source == oci_core_network_security_group.vm["vm-i"].id
    error_message = "ingest-internal source must be the vm-i group"
  }

  assert {
    condition     = alltrue([for k, r in oci_core_network_security_group_security_rule.private : r.source_type == "NETWORK_SECURITY_GROUP"])
    error_message = "private rules must name a network group, never an address range"
  }
}

run "default_security_list_has_no_ssh" {
  command = apply

  assert {
    condition     = length([for r in oci_core_default_security_list.main.ingress_security_rules : r if r.protocol != "1"]) == 0
    error_message = "the default security list must only allow ICMP path MTU discovery"
  }
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

run "bad_availability_domain_gives_a_clear_error" {
  command = plan
  variables {
    availability_domain_index = 5
  }
  expect_failures = [oci_core_instance.vm]
}
