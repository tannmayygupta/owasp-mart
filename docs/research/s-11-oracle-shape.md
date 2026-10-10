# S-11: Oracle shape and capacity (spike record)

Status: **template; the live fields are empty until the developer applies Terraform** (runbook Part B). Do not write addresses, OCIDs or account details here.

## Question
Can two `VM.Standard.A1.Flex` instances with 1 OCPU and 6 GB each be created in the Mumbai home region, and do they stay alive?

## Read from Oracle (2026-10-10, "Always Free Resources" page)
- A1 allowance: 1,500 OCPU hours and 9,000 GB hours a month; for an Always Free tenancy 2 OCPUs and 12 GB; one or two A1 instances.
- Block storage: 200 GB total for boot and block volumes. The page gives 47 GB (compute section) and 50 GB (block volume section) as the minimum boot volume; this setup uses 50 GB each (100 GB of 200).
- Idle: over a 7-day period CPU p95 under 20 percent, network under 20 percent and memory under 20 percent (A1 only).
- Always Free compute and block volumes must be in the home region. An "out of host capacity" error means a temporary lack of Always Free shapes there.
- Not stated on the page: Pay As You Go effect on reclaim, public IP count on A1.

## Fields to fill from the live run
| Field | Value |
|---|---|
| Date of first apply | |
| Result per availability domain (domain index, date, created or capacity error) | |
| Number of attempts before success | |
| Image used (Ubuntu 24.04 aarch64 build name) | |
| Boot volume size, shape config as shown in the console | |
| Memory use of the keep-alive service (percent, from OCI metrics) after 1 day and after 7 days | |
| Did the idle alarm fire without cause? | |
| Anything Oracle changed or said (reply to the terms e-mail) | |
| Decision for laptop fallback (still valid? yes/no) | |

## Open questions to answer
- Did Pay As You Go ever need to be considered? (Decision D-40: never.)
- Is the home region permanent? (Unverified.)
- Does the memory metric of the Oracle agent count the keep-alive memory? (Check in Part D.)
