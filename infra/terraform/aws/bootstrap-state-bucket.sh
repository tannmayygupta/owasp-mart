#!/bin/sh
# Creates the S3 bucket that holds the Terraform state (D-45). Run BY THE DEVELOPER, once, never by Claude.
# Needs the AWS CLI and credentials that may create buckets (the Terraform user's policy has a bootstrap statement for this: remove it afterwards).
# Usage: sh bootstrap-state-bucket.sh <globally-unique-bucket-name>
# It creates the bucket in ap-southeast-2 with versioning, default encryption (SSE-S3) and all public access blocked. It never overwrites an existing bucket.
set -eu
BUCKET="${1:?bucket name required, for example vulnmart-tfstate-<something-unique>}"
REGION=ap-southeast-2
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "bucket $BUCKET ready. Next: copy backend.hcl.example to backend.hcl, set the bucket name, and follow the runbook section 'Move the state to S3'."