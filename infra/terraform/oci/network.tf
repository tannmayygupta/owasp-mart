locals {
  rules = jsondecode(file("${path.module}/network-rules.json"))

  # One flat entry per (rule, source address). "$ssh_source_cidrs" expands to the variable.
  public_flat = flatten([
    for r in local.rules.public_ingress : [
      for s in flatten([for x in r.sources : x == "$ssh_source_cidrs" ? var.ssh_source_cidrs : [x]]) : {
        name   = r.name
        port   = r.port
        source = s
      }
    ]
  ])
  public_rules = { for r in local.public_flat : "${r.name}-${r.source}" => r }

  private_rules = { for r in local.rules.private_ingress : r.name => r }

  vm_names = ["vm-p", "vm-i"]
}

resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_ocid
  display_name   = "vulnmart-vcn"
  cidr_blocks    = [local.rules.vcn_cidr]
  dns_label      = "vulnmart"
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "vulnmart-igw"
  enabled        = true
}

resource "oci_core_default_route_table" "main" {
  manage_default_resource_id = oci_core_vcn.main.default_route_table_id
  display_name               = "vulnmart-default-routes"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

# The VCN default security list normally lets port 22 in from anywhere. It is replaced here:
# no ingress except path MTU discovery; ports come only from the NSGs below.
resource "oci_core_default_security_list" "main" {
  manage_default_resource_id = oci_core_vcn.main.default_security_list_id
  display_name               = "vulnmart-default-closed"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = local.rules.icmp_ingress
    content {
      source   = "0.0.0.0/0"
      protocol = "1"
      icmp_options {
        type = ingress_security_rules.value.type
        code = ingress_security_rules.value.code
      }
    }
  }
}

resource "oci_core_subnet" "main" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.main.id
  display_name               = "vulnmart-subnet"
  cidr_block                 = local.rules.subnet_cidr
  dns_label                  = "main"
  prohibit_public_ip_on_vnic = false
  security_list_ids          = [oci_core_default_security_list.main.id]
  route_table_id             = oci_core_default_route_table.main.id
}

resource "oci_core_network_security_group" "vm" {
  for_each       = toset(local.vm_names)
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.main.id
  display_name   = "nsg-${each.key}"
}

# Public ingress: every VM gets the same list.
resource "oci_core_network_security_group_security_rule" "public" {
  for_each = {
    for pair in setproduct(local.vm_names, keys(local.public_rules)) :
    "${pair[0]}/${pair[1]}" => { vm = pair[0], rule = local.public_rules[pair[1]] }
  }
  network_security_group_id = oci_core_network_security_group.vm[each.value.vm].id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value.rule.source
  source_type               = "CIDR_BLOCK"
  description               = each.value.rule.name

  tcp_options {
    destination_port_range {
      min = each.value.rule.port
      max = each.value.rule.port
    }
  }
}

# Private ingress: only from the other VM's NSG, only the named port.
resource "oci_core_network_security_group_security_rule" "private" {
  for_each                  = local.private_rules
  network_security_group_id = oci_core_network_security_group.vm[each.value.to].id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = oci_core_network_security_group.vm[each.value.from].id
  source_type               = "NETWORK_SECURITY_GROUP"
  description               = each.value.name

  tcp_options {
    destination_port_range {
      min = each.value.port
      max = each.value.port
    }
  }
}

# Egress: the hosts pull images and certificates, so all outbound traffic is allowed.
resource "oci_core_network_security_group_security_rule" "egress" {
  for_each                  = toset(local.vm_names)
  network_security_group_id = oci_core_network_security_group.vm[each.key].id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "all outbound"
}
