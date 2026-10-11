terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }
}

# Credentials are never in this folder: the provider reads them from the developer's AWS CLI profile or environment
# (runbook Part A). The limited IAM user is described in iam-policy.json.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project = "vulnmart"
      Managed = "terraform"
    }
  }
}
