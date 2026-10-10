locals {
  # t4g types are Arm (arm64); everything else on the eligible list is x86 (amd64).
  arch = { for k, t in var.instance_types : k => startswith(t, "t4g.") ? "arm64" : "amd64" }

  # One cloud-init for both hosts: the same baseline by construction.
  hosts_dir = "${path.module}/../../hosts"
  user_data_raw = templatefile("${local.hosts_dir}/cloud-init.yaml.tftpl", {
    sshd_conf         = base64encode(file("${local.hosts_dir}/sshd-hardening.conf"))
    firewall_sh       = base64encode(file("${local.hosts_dir}/vulnmart-firewall.sh"))
    docker_sh         = base64encode(file("${local.hosts_dir}/vulnmart-install-docker.sh"))
    baseline_sh       = base64encode(file("${local.hosts_dir}/vulnmart-baseline.sh"))
    docker_daemon     = base64encode(file("${local.hosts_dir}/docker-daemon.json"))
    keepalive_py      = base64encode(file("${local.hosts_dir}/vulnmart-keepalive.py"))
    keepalive_unit    = base64encode(file("${local.hosts_dir}/vulnmart-keepalive.service"))
    private_cidr      = local.rules.subnet_cidr
    ntp_server        = "169.254.169.123" # Amazon Time Sync Service (link-local)
    ssh_keys_json     = jsonencode(var.ssh_public_keys)
    keepalive_enabled = var.keepalive_enabled ? "yes" : "no"
  })

  user_data = local.user_data_raw

  key_pair_public_key = sort(var.ssh_public_keys)[0]

  # Size in BYTES (not characters): base64 length times 3/4 minus the padding. The EC2 limit is 16384 (unverified).
  user_data_b64   = textencodebase64(local.user_data_raw, "UTF-8")
  user_data_bytes = length(local.user_data_b64) / 4 * 3 - (endswith(local.user_data_b64, "==") ? 2 : (endswith(local.user_data_b64, "=") ? 1 : 0))
}

# Ubuntu 24.04 from Canonical's public SSM parameter, per architecture. Re-resolved on a rebuild; running hosts
# ignore later image changes (the instance below ignores ami).
data "aws_ssm_parameter" "ubuntu" {
  for_each        = toset(distinct(values(local.arch)))
  name            = "/aws/service/canonical/ubuntu/server/24.04/stable/current/${each.key}/hvm/ebs-gp3/ami-id"
  with_decryption = false
}

# Fallback key pair only (cloud-init installs every developer key). The key used is the first of the SORTED list, so
# reordering the list changes nothing; the public key is ignored after creation so adding a developer never recreates it.
# Import after a lost state: terraform import aws_key_pair.main <key name from the console> (runbook Part G).
resource "aws_key_pair" "main" {
  key_name_prefix = "vulnmart-"
  public_key      = local.key_pair_public_key

  lifecycle {
    ignore_changes = [public_key]
  }
}

resource "aws_instance" "vm" {
  for_each = toset(local.vm_names)

  ami                         = data.aws_ssm_parameter.ubuntu[local.arch[each.key]].insecure_value
  instance_type               = var.instance_types[each.key]
  subnet_id                   = aws_subnet.main.id
  vpc_security_group_ids      = [aws_security_group.vm[each.key].id]
  associate_public_ip_address = true # replaced by the Elastic IP below
  key_name                    = aws_key_pair.main.key_name
  user_data                   = local.user_data

  # IMDSv2 only and one hop: a container (one extra hop) cannot read instance metadata. No instance profile is attached.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = { Name = each.key }

  # The root disks carry the project tag too, so a lost state can be cleaned up by tag (runbook Part G).
  volume_tags = { Project = "vulnmart" }

  lifecycle {
    # A running host is never replaced for a newer image or a changed startup file
    # (runbook, "Change a host file or add a developer key").
    ignore_changes = [ami, user_data, key_name]

    # AWS limits user data to 16 KB before encoding (unverified: read the EC2 user data page in the runbook check).
    precondition {
      condition     = local.user_data_bytes <= 16384
      error_message = "The cloud-init user data is larger than 16384 bytes, the EC2 limit (unverified). Shrink the host files or gzip the data."
    }
  }
}

# Stopping the labs host is one line: vm_i_running = false, then apply (disks and the Elastic IP stay).
resource "aws_ec2_instance_state" "vm_i" {
  instance_id = aws_instance.vm["vm-i"].id
  state       = var.vm_i_running ? "running" : "stopped"
}

# The public address survives stop and start (an auto-assigned address does not).
resource "aws_eip" "vm" {
  for_each = toset(local.vm_names)
  domain   = "vpc"
  instance = aws_instance.vm[each.key].id

  tags = { Name = "eip-${each.key}" }

  depends_on = [aws_internet_gateway.main]
}
