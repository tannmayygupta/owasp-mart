# Marked sensitive so `apply` does not print addresses into logs or chat. Save them locally with:
#   terraform output -json > hosts.local.json      (git-ignored; read by scripts/verify-hosts.mjs)
output "vm_p_public_ip" {
  value     = aws_eip.vm["vm-p"].public_ip
  sensitive = true
}

output "vm_p_private_ip" {
  value     = aws_instance.vm["vm-p"].private_ip
  sensitive = true
}

output "vm_i_public_ip" {
  value     = aws_eip.vm["vm-i"].public_ip
  sensitive = true
}

output "vm_i_private_ip" {
  value     = aws_instance.vm["vm-i"].private_ip
  sensitive = true
}

# Not secret: needed to stop and start the labs host (runbook Part D).
output "instance_ids" {
  value = { for k, i in aws_instance.vm : k => i.id }
}
