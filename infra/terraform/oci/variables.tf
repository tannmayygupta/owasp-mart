variable "region" {
  description = "Home region identifier (India South Mumbai: ap-mumbai-1)."
  type        = string
  default     = "ap-mumbai-1"
}

variable "tenancy_ocid" {
  description = "Tenancy OCID. Local file only, never committed."
  type        = string
  sensitive   = true
}

variable "user_ocid" {
  description = "OCID of the API user. Local file only."
  type        = string
  sensitive   = true
}

variable "fingerprint" {
  description = "Fingerprint of the API public key. Local file only."
  type        = string
  sensitive   = true
}

variable "private_key_path" {
  description = "Path to the API private key outside the repository."
  type        = string
  sensitive   = true
}

variable "compartment_ocid" {
  description = "Compartment for all resources (the tenancy root works for a first run)."
  type        = string
  sensitive   = true
}

variable "ssh_source_cidrs" {
  description = "Source addresses allowed to reach port 22, for example [\"198.51.100.7/32\"]. Never the whole internet."
  type        = list(string)

  validation {
    condition     = length(var.ssh_source_cidrs) > 0 && alltrue([for c in var.ssh_source_cidrs : can(cidrhost(c, 0))])
    error_message = "ssh_source_cidrs must list at least one valid CIDR such as 198.51.100.7/32 (placeholders are not valid)."
  }

  validation {
    condition     = !contains(var.ssh_source_cidrs, "0.0.0.0/0") && !contains(var.ssh_source_cidrs, "::/0")
    error_message = "ssh_source_cidrs must not contain 0.0.0.0/0 or ::/0."
  }

  validation {
    condition = alltrue([
      for c in var.ssh_source_cidrs :
      !can(cidrhost(c, 0)) || (strcontains(c, ":") ? tonumber(split("/", c)[1]) >= 48 : tonumber(split("/", c)[1]) >= 16)
    ])
    error_message = "ssh_source_cidrs: IPv4 prefixes must be /16 or longer (IPv6: /48 or longer); a shorter prefix is almost the whole internet."
  }

  validation {
    condition     = length(distinct(var.ssh_source_cidrs)) == length(var.ssh_source_cidrs)
    error_message = "ssh_source_cidrs must not contain duplicates."
  }
}

variable "ssh_public_keys" {
  description = "Public keys of the three developers, one per list item (ed25519 or rsa, public half only)."
  type        = list(string)

  validation {
    condition     = length(var.ssh_public_keys) >= 1 && alltrue([for k in var.ssh_public_keys : can(regex("^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( .*)?$", k))])
    error_message = "ssh_public_keys must be public keys in the form 'ssh-ed25519 AAAA... comment' (or ssh-rsa)."
  }

  validation {
    condition     = alltrue([for k in var.ssh_public_keys : !strcontains(k, "PRIVATE") && !strcontains(k, "AAAA...")])
    error_message = "ssh_public_keys must not contain a private key or the example placeholder."
  }

  validation {
    condition     = length(distinct(var.ssh_public_keys)) == length(var.ssh_public_keys)
    error_message = "ssh_public_keys must not contain duplicates."
  }
}
variable "availability_domain_index" {
  description = "Which availability domain to use. Change it when Arm capacity is refused (runbook, Arm capacity)."
  type        = number
  default     = 0
}

variable "alarm_email" {
  description = "E-mail address of the account owner for the idle alarm."
  type        = string
  sensitive   = true
}

variable "ocpus" {
  type    = number
  default = 1
}

variable "memory_in_gbs" {
  type    = number
  default = 6
}

variable "boot_volume_gbs" {
  description = "Two boot volumes count against the shared 200 GB Always Free block storage."
  type        = number
  default     = 50
}

variable "public_web_cidrs" {
  description = "Source addresses for ports 80 and 443 (Oracle option, unused). Open to the internet by default, as before."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
