# 0027. Labs host isolation, IAM guard and remote state (decisions D-43, D-44, D-45)

- **Status:** Proposed (decided on the developer's delegation 2026-10-11, story 1.15; nothing applied). **Nothing in this record has been applied to AWS.** The developer must run `terraform plan`, read it, and apply. The earlier live results (`verify-hosts` 94 checks, `private-link-check` 22 checks, ADR 0022) were measured on the OLD network (one subnet, all outbound traffic allowed) and must be measured again after the apply.
- **Date:** 2026-10-11
- **Deciders:** Tanmay (delegated to the coding agent for this story; to be confirmed by the developer)
- **Requirements:** NFR-ISO-06, R-1, R-4, D-41, D-43, D-44, D-45, review finding H-103 (PR 3 review), ADR 0022

## Context
The review of PR 3 (finding H-103) found that the labs host `vm-i`, which runs deliberately vulnerable containers, shared one subnet with the platform host, could send any traffic anywhere, and had only a placeholder host firewall. A container that is compromised could reach the platform host's ports, the cloud instance metadata service, and the internet. Separately, the Terraform user policy still allowed `ec2:ModifyInstanceAttribute` (it cannot be limited by instance type), and the Terraform state is one local file with no locking and no history.

## Options considered
1. **NAT gateway and private subnet for the labs host.** The proper pattern, but a NAT gateway costs about USD 0.045 per hour (about USD 33 per month) on a USD 100 to 200 credit. Rejected for cost.
2. **A separate VPC for the labs host.** Strong separation, but peering or a transit path is needed for ports 9443 and 9444, and it doubles the network resources. Rejected: more moving parts than two subnets with security groups, ACLs and host rules.
3. **Rely on the metadata hop limit alone (status quo).** It stops a bridge container from reading metadata, but not a host-network container, not the VPC range, and not outbound traffic. Rejected as the only control.
4. **Local state with a backup only.** No locking and no history; a second developer or a half-finished apply can corrupt it. Rejected in favour of S3 with native locking.
5. **Chosen: layered controls without extra monthly cost** (below).

## Decision
**D-43, isolation of the labs host (all in `infra/`, nothing applied):**
- Two subnets in the VPC (`subnet_p_cidr` 10.0.0.0/24 for the platform host, `subnet_i_cidr` 10.0.1.0/24 for the labs host), each with its own route table (0.0.0.0/0 to the internet gateway; no NAT). The platform subnet keeps the old address, so `vm-p` is not replaced; **`vm-i` moves subnet and Terraform will replace it** (the labs host holds no state that is not rebuilt by cloud-init; confirm in the plan).
- Security groups: `vm-i` outbound is an allowlist: tcp 443 to the internet, tcp 80 to the internet (see "apt over http" below), tcp and udp 53 to the VPC resolver, udp 123 to the Amazon time server, tcp 9444 to the `vm-p` security group only. No rule with protocol -1. `vm-p` outbound is the same list plus tcp 9443 to the `vm-i` group; it has no all-protocol rule either.
- Network ACLs (stateless): subnet-i outbound allows 9444 to subnet-p and DNS to the resolver, then **denies the whole VPC range (rule 150) before any allow to the internet (rules 200 and up)**; inbound allows the public ports from the listed sources, 9443 from subnet-p, ephemeral replies and path-MTU ICMP. Subnet-p allows 9444 from subnet-i, the public ports from the listed sources and replies. NACLs cannot filter 169.254.169.254 (link-local).
- Host rules on `vm-i` (`vulnmart-egress.sh`, started by `vulnmart-egress.service` after Docker and re-run when Docker restarts): the chain `VULNMART-LABS`, reached from `DOCKER-USER` for the lab bridge subnets (172.17.0.0/16 and the Docker pool 172.30.0.0/16): replies return; DNS to the resolver, ntp and tcp 9444 to the platform subnet are accepted; the link-local range, the VPC range and the host's own address are dropped; tcp 443 is accepted; everything else, including port 80, is dropped. `INPUT` drops new connections from the lab subnets to the host. `OUTPUT` drops 169.254.169.254 for every process that is not root. The firewall script now sets the INPUT policy to DROP last, after loopback, established, ICMP type 3, DHCP, the public ports and the private ports; it never flushes a chain and skips `netfilter-persistent save` when Docker chains exist.
- A lint (`scripts/check-lab-compose-rules.mjs`) fails any compose or harness file that uses `privileged: true`, `network_mode: host`, `pid: host`, `ipc: host`, mounts the Docker socket, or adds `SYS_ADMIN`, `NET_ADMIN` or another dangerous capability. There is no exception list. The two committed files (`infra/compose/compose.yaml`, `infra/compose/harness.yaml`) pass; nothing existing violated the rule.

**Plain statement of the limit:** a root or privileged container, or a container with host networking, can change or bypass host filters (iptables rules, the `OUTPUT` owner match, `DOCKER-USER`). The host rules are a second layer that stops ordinary containers; the **VPC security groups and the network ACLs are the real boundary**, which is why they are the first items above. A root container that shares the host network can still read instance metadata (the hop limit does not apply on the host network); only the compose lint and review keep such containers out.

**apt over http.** The Ubuntu 24.04 image fetches packages over `http://`. Port 80 outbound is therefore kept on both hosts for now (variable `apt_http_egress`, default true). The container-level rules never allow port 80. Setting the variable to false is tested and removes the rule once apt is switched to https and tried on a spare host.

**D-44, IAM guard (`iam-policy.json`):** `ec2:ModifyInstanceAttribute` is removed from every Allow (it cannot be limited by instance type, so a leaked key could resize a stopped instance). An explicit Deny of `ec2:RunInstances` on instances applies when `ec2:InstanceType` is not one of the six Free Plan eligible types listed in the variable check (the same list as the existing Allow; it includes the defaults t3.small and m7i-flex.large). The tag and region conditions stay. The policy also gains the network ACL actions and the S3 actions for the state bucket (below). The policy in the AWS console is a copy: the developer pastes the new file. Run one `terraform plan` first; if a real change needs `ModifyInstanceAttribute` (for example changing the instance type), add a temporary statement and remove it afterwards.

**D-45, remote state:** an S3 backend with partial configuration (`backend.tf.example`, settings in the git-ignored `backend.hcl` made from `backend.hcl.example`: bucket, key, region, `encrypt = true`, `use_lockfile = true`). Native S3 locking needs Terraform 1.11 or newer, so `required_version` is `>= 1.11.0, < 2.0.0`; the local Terraform and the CI image are 1.16.5 (checked). `backend.tf` is **not** committed: a backend block would make the plain `terraform init` ask for a bucket and would break the developer's current local state and the tests' `init -backend=false` flow only until migration; the runbook has the steps and the rollback. `bootstrap-state-bucket.sh` creates the bucket (versioning, SSE-S3, public access blocked); it is run by the developer, never by the agent.

## Consequences
- Easier: a compromised lab container cannot reach the platform host, the VPC or the metadata service by ordinary means, and cannot send anything to the internet except https. State has history and locking.
- Harder: lab images may only pull over https; anything that needs another outbound port now needs a rule in `network-rules.json` and a record. A host-network or root container is the known gap.
- Plan changes: `vm-i` is replaced (new subnet), the cloud-init user data is now sent gzip-compressed (it grew past the 16 KB limit), both security groups lose the all-outbound rule, the old subnet resources are renamed with `moved` blocks (no recreation).
- Unverified until the developer applies: that AWS accepts every NACL entry, that the Ubuntu apt mirrors work with the rules, that the `docker0` default bridge uses the resolver as expected, that the instance replacement keeps both Elastic IP associations, and that the IAM policy without `ModifyInstanceAttribute` lets a plain plan and apply through.

## Residual risks
- Root, privileged or host-network containers can bypass host filters; the compose lint is the only guard against asking for them.
- `vm-p` outbound is now an allowlist too: a service that needs another port (for example mail) will fail until a rule is added. Unverified against the running platform host.
- Security groups and NACLs do not filter instance metadata or, in practice, the VPC resolver; the hop limit and the host `OUTPUT` rule cover metadata for ordinary containers only.
- Subnet-p NACL outbound is open (the security group list is the filter there).
- Port 80 outbound stays open while apt uses http.
- NACL ephemeral ranges allow any source on high ports at the subnet level; the security groups still decide.
- Web ports 80 and 443 stay open to the listed sources on `vm-i` as before (the security group and NACL mirror each other); whether the labs host needs them at all is an open design question for the developer.

## Evidence
- Docker packet filtering and firewalls (DOCKER-USER, published ports bypass INPUT): https://docs.docker.com/engine/network/packet-filtering-firewalls/
- Terraform S3 backend (`use_lockfile`, partial configuration): https://developer.hashicorp.com/terraform/language/backend/s3
- EC2 actions, resources and condition keys (`ModifyInstanceAttribute` has no instance type condition key): https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html
- VPC network ACLs (stateless, rule order, no link-local filtering): https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html
- NAT gateway price (about USD 0.045 per hour in the plan notes): not re-checked on the AWS pricing page; treat as unverified.
- Tests run in this story: see the dev-log entry of story 1.15 (host script tests with a stub iptables, `terraform test` on the mocked provider, static policy tests). No live test was run.