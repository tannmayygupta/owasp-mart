# Marked sensitive so `apply` does not print addresses into logs or chat. Save them locally with:
#   terraform output -json > hosts.local.json      (git-ignored; read by scripts/verify-hosts.mjs)
output "vm_p_public_ip" {
  value     = oci_core_instance.vm["vm-p"].public_ip
  sensitive = true
}

output "vm_p_private_ip" {
  value     = oci_core_instance.vm["vm-p"].private_ip
  sensitive = true
}

output "vm_i_public_ip" {
  value     = oci_core_instance.vm["vm-i"].public_ip
  sensitive = true
}

output "vm_i_private_ip" {
  value     = oci_core_instance.vm["vm-i"].private_ip
  sensitive = true
}
