---
id: story-wp-c-deployment-hardening
title: Work package C, deployment hardening, scheduler, real mail, dashboards and durable state
state: in-review
initiative: initiative-lab
requirements: [F-02, F-03, F-04, F-12, F-13]
branch: wp-c-deploy-hardening
---

# Story: deployment hardening

## Acceptance
1. The dashboards run as a container on the platform host behind the same Caddy (one origin); every dashboards page path is routed to it.
2. The retention scheduler is on in the deployed compose; mail is Brevo by default and the catcher needs an explicit flag; production refuses to start on a catcher or an empty key.
3. Production refuses missing Postgres and keystore settings; Valkey has a password, append-only persistence and an eviction policy that never drops queued mail ids.
4. The edge gate and the sidecar keep their state across a restart; the orchestrator is told by the platform which instances should exist (IF-5 1.2.0).
5. A lint of the deployed files, a route/contract check and a skip budget run in CI.