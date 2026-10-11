variable "region" {
  description = "AWS region. Sydney is the only region this account can use (Mumbai is denied for the account)."
  type        = string
  default     = "ap-southeast-2"

  validation {
    condition     = var.region == "ap-southeast-2"
    error_message = "region must be ap-southeast-2 (Sydney): it is the only region this account can use. Record the error in the runbook if you want to try another."
  }
}

variable "availability_zone" {
  description = "Availability zone for the subnet, for example ap-southeast-2a. Null lets AWS choose. Change it when an instance type is refused in the zone (runbook Part B)."
  type        = string
  default     = null
}

variable "ssh_source_cidrs" {
  description = "Source addresses allowed to reach port 22, for example [\"198.51.100.7/32\"]. Never the whole internet."
  type        = list(string)

  validation {
    condition     = length(var.ssh_source_cidrs) > 0 && alltrue([for c in var.ssh_source_cidrs : can(cidrhost(c, 0))])
    error_message = "ssh_source_cidrs must list at least one valid CIDR such as 198.51.100.7/32 (placeholders are not valid)."
  }

  validation {
    condition     = anytrue([for c in var.ssh_source_cidrs : !strcontains(c, ":")])
    error_message = "ssh_source_cidrs must contain at least one IPv4 CIDR: the VPC has no IPv6, so an IPv6-only list would lock everybody out."
  }

  validation {
    condition     = alltrue([for c in var.ssh_source_cidrs : !can(cidrhost(c, 0)) || cidrsubnet(c, 0, 0) == c])
    error_message = "ssh_source_cidrs: write each CIDR in canonical form (the host bits must be zero, for example 10.0.0.0/16, not 10.0.0.5/16)."
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

variable "public_web_cidrs" {
  description = "Source addresses allowed to reach ports 80 and 443. Null (the default) means the same list as ssh_source_cidrs, so nothing is open to the internet. Set [\"0.0.0.0/0\"] only on purpose, when the team opens the lab to outside users (PRD R-4)."
  type        = list(string)
  default     = null

  validation {
    condition     = var.public_web_cidrs == null ? true : length(var.public_web_cidrs) > 0 && alltrue([for c in var.public_web_cidrs : can(cidrhost(c, 0))])
    error_message = "public_web_cidrs must be null or a non-empty list of valid CIDRs."
  }

  validation {
    condition     = var.public_web_cidrs == null ? true : alltrue([for c in var.public_web_cidrs : c == "0.0.0.0/0" || !can(cidrhost(c, 0)) || cidrsubnet(c, 0, 0) == c])
    error_message = "public_web_cidrs: write each CIDR in canonical form (host bits zero)."
  }

  validation {
    condition = var.public_web_cidrs == null ? true : alltrue([
      for c in var.public_web_cidrs :
      c == "0.0.0.0/0" || !can(cidrhost(c, 0)) || (strcontains(c, ":") ? tonumber(split("/", c)[1]) >= 48 : tonumber(split("/", c)[1]) >= 16)
    ])
    error_message = "public_web_cidrs: apart from the explicit 0.0.0.0/0, IPv4 prefixes must be /16 or longer (IPv6: /48 or longer)."
  }

  validation {
    condition     = var.public_web_cidrs == null ? true : !contains(var.public_web_cidrs, "::/0") && length(distinct(var.public_web_cidrs)) == length(var.public_web_cidrs)
    error_message = "public_web_cidrs must not contain ::/0 or duplicates."
  }
}

variable "ssh_public_keys" {
  description = "Public keys of the three developers, one per list item (ed25519 or rsa, public half only). The first one is also registered as the EC2 key pair."
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

variable "instance_types" {
  description = "Instance type per host. Only Free Plan eligible types (read from AWS on 2026-10-11): t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large. t4g is Arm; the others are x86."
  type        = map(string)
  default = {
    "vm-p" = "t3.small"
    "vm-i" = "m7i-flex.large"
  }

  validation {
    condition     = length(setsubtract(keys(var.instance_types), ["vm-p", "vm-i"])) == 0 && length(setsubtract(["vm-p", "vm-i"], keys(var.instance_types))) == 0
    error_message = "instance_types must have exactly the keys vm-p and vm-i."
  }

  validation {
    condition = alltrue([
      for t in values(var.instance_types) :
      contains(["t3.micro", "t3.small", "t4g.micro", "t4g.small", "c7i-flex.large", "m7i-flex.large"], t)
    ])
    error_message = "instance_types: every type must be Free Plan eligible (t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large); others are refused or spend money. Source: the AWS Free Tier EC2 page, read 2026-10-11. To change the list on purpose: edit this list, the ec2:InstanceType condition in iam-policy.json and the list in scripts/check-network-rules.test.mjs together, and record the new source in ADR 0022."
  }
}

variable "root_volume_gb" {
  description = "Size of each root disk in GB (gp3). The Free Plan limit on disk size is unverified: lower it if AWS refuses."
  type        = number
  default     = 30

  validation {
    condition     = var.root_volume_gb >= 20 && var.root_volume_gb <= 100
    error_message = "root_volume_gb must be between 20 and 100."
  }
}

variable "keepalive_enabled" {
  description = "Run the keep-alive load service on the hosts. Off on AWS unless AWS is found to reclaim idle instances."
  type        = bool
  default     = false
}

variable "budget_email" {
  description = "E-mail address of the account owner for the budget and credit alerts."
  type        = string
  sensitive   = true
}

variable "credit_total_usd" {
  description = "Size of the credit in USD: the Free Plan gives 100 and up to 100 more can be earned (so up to 200). The monthly budget limit must not exceed it."
  type        = number
  default     = 120

  validation {
    condition     = var.credit_total_usd > 0
    error_message = "credit_total_usd must be greater than 0."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly usage limit (before credits) that the budget alerts at 50, 80 and 100 percent of. AWS Budgets lags by up to a day and only sends e-mail: the weekly credit check in the Billing console is the real control."
  type        = number
  default     = 60

  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= var.credit_total_usd
    error_message = "monthly_budget_usd must be above 0 and not above credit_total_usd."
  }
}

variable "vm_i_running" {
  description = "Whether the labs host is running. Set false and apply to stop it (disks and the Elastic IP stay); set true to start it again."
  type        = bool
  default     = true
}

variable "apt_http_egress" {
  description = "Allow outbound tcp 80 on both hosts. Needed while apt uses the Ubuntu mirrors over http (the Ubuntu 24.04 image default). Set false once apt is switched to https and a test host proved it (ADR 0027); the labs host's containers never get port 80 either way (host rules)."
  type        = bool
  default     = true
}
