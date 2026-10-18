data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Newest Ubuntu 24.04 image for Arm (D-34). Re-resolved on a rebuild; running hosts ignore later image changes.
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  # One cloud-init for both hosts: the same baseline by construction.
  hosts_dir = "${path.module}/../../hosts"
  user_data = base64encode(templatefile("${local.hosts_dir}/cloud-init.yaml.tftpl", {
    sshd_conf         = base64encode(file("${local.hosts_dir}/sshd-hardening.conf"))
    firewall_sh       = base64encode(file("${local.hosts_dir}/vulnmart-firewall.sh"))
    docker_sh         = base64encode(file("${local.hosts_dir}/vulnmart-install-docker.sh"))
    baseline_sh       = base64encode(file("${local.hosts_dir}/vulnmart-baseline.sh"))
    docker_daemon     = base64encode(file("${local.hosts_dir}/docker-daemon.json"))
    keepalive_py      = base64encode(file("${local.hosts_dir}/vulnmart-keepalive.py"))
    keepalive_unit    = base64encode(file("${local.hosts_dir}/vulnmart-keepalive.service"))
    egress_sh         = indent(6, file("${local.hosts_dir}/vulnmart-egress.sh"))
    egress_unit       = base64encode(file("${local.hosts_dir}/vulnmart-egress.service"))
    certs_sh          = indent(6, file("${local.hosts_dir}/vulnmart-certs.sh"))
    reload_caddy_sh   = indent(6, file("${local.hosts_dir}/vulnmart-reload-caddy.sh"))
    certs_unit        = indent(6, file("${local.hosts_dir}/vulnmart-certs.service"))
    certs_timer       = indent(6, file("${local.hosts_dir}/vulnmart-certs.timer"))
    lego_pin          = indent(6, file("${local.hosts_dir}/lego.pin.json"))
    lego_install_sh   = indent(6, file("${local.hosts_dir}/vulnmart-install-lego.sh"))
    egress_env        = jsonencode("# Not used on Oracle: no LABS_HOST_SUBNET, so vulnmart-egress.sh does nothing.\n")
    private_cidr      = local.rules.subnet_cidr
    ntp_server        = "169.254.169.254"
    ssh_keys_json     = jsonencode([])
    keepalive_enabled = "yes"
  }))
  ssh_keys = join("\n", var.ssh_public_keys)
}

resource "oci_core_instance" "vm" {
  for_each            = toset(local.vm_names)
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = each.key
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.main.id
    assign_public_ip = true
    hostname_label   = each.key
    nsg_ids          = [oci_core_network_security_group.vm[each.key].id]
  }

  metadata = {
    ssh_authorized_keys = local.ssh_keys
    user_data           = local.user_data
  }

  # The monitoring plugin feeds the idle alarm (alarms.tf).
  agent_config {
    plugins_config {
      name          = "Compute Instance Monitoring"
      desired_state = "ENABLED"
    }
  }

  lifecycle {
    # A running VM is never replaced for a newer image or a changed startup file or key list
    # (runbook, "Change a host file or add a developer key").
    ignore_changes = [source_details[0].source_id, metadata["user_data"], metadata["ssh_authorized_keys"]]

    precondition {
      condition     = var.availability_domain_index >= 0 && var.availability_domain_index < length(data.oci_identity_availability_domains.ads.availability_domains)
      error_message = "availability_domain_index is outside the list of availability domains of this region."
    }

    precondition {
      condition     = length(data.oci_core_images.ubuntu.images) > 0
      error_message = "No Ubuntu 24.04 image for VM.Standard.A1.Flex was found in this region and compartment."
    }
  }
}
