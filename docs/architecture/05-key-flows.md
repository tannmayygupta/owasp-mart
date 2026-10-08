# 05. Key flows

Status: PROPOSED (2026-10-08). Each flow is a sequence diagram with its failure branches. Requirement IDs refer to [PRD.md](../prd/PRD.md). Names: `API` is the platform API codebase (API, ingest, SSE hub and workers are processes of it, see [01](01-overview-and-components.md)); `edge` is the labs edge; `gate` is the access gate. Spikes and ADRs are named where the flow depends on them.

Contents: 1 learner starts an instance, 2 candidate invite, consent and start, 3 candidate attempt to destroy, 4 events to scoring to live updates, 5 flags (derive, inject, capture, paste), 6 recruiter and company approval, 7 break-glass, 8 retention and deletion, 9 reconciler after an orchestrator crash, 10 reset.

## 1. Learner starts an instance (FR-INS-01, 02, 04, 06, 07, 11, FR-ACC-02)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant Q as Valkey queue
    participant W as Worker
    participant O as Orchestrator
    participant D as Docker
    participant G as gate and edge
    B->>A: POST /api/instances (kind learner) with session and CSRF
    A->>A: email verified, quotas (user and global), template on allowlist
    alt email not verified
        A-->>B: 403 verify email first
    else quota or global cap reached
        A-->>B: 429 or 409 with a clear message (request may queue if the Admin allows)
    else accepted
        A->>A: insert attempt (learner) and instance (requested) and domain event in one transaction
        A-->>B: 202 instance id (status stream follows)
        A->>Q: enqueue provision(instance id)
        Q->>W: job
        W->>W: epoch 1, flags and decoys (HMAC), flag digests, event key, hostname
        W->>O: create instance (signed, mTLS): id, template id, epoch, flags, digests, event key
        alt orchestrator unreachable
            W->>Q: retry with back-off
            Note over A,B: state stays requested, dashboard shows waiting
            W->>A: after the retry limit mark failed and notify
        else accepted (idempotent on id and epoch)
            O->>O: validate id format, template allowlist, signature
            O->>D: create inst and front networks (internal), containers with limits and labels
            O->>D: attach edge to the front network
            O->>D: run injector (flags on stdin), start shop, mock, import, sidecar (digests on stdin)
            O->>A: report provisioning then starting
            O->>D: wait for shop health through the sidecar
            alt health timeout, injector error or container exit
                O->>D: retry once or twice (OI-24)
                O->>D: if still failing destroy networks and containers
                O->>A: report failed (instance is never shown ready, FR-INS-11)
                A-->>B: stream: failed with a clear message
            else healthy and flags injected
                O->>G: push access state open and access epoch
                O->>A: report ready
                A-->>B: stream: ready
            end
        end
    end
    Note over B,G: opening the shop uses the ticket flow in 03, section 3
```

## 2. Candidate: invite, consent, start (FR-ASM-02 to 06, FR-ACC-06, FR-PRV-01, 02, FR-SES-01)

```mermaid
sequenceDiagram
    autonumber
    participant R as Recruiter
    participant A as API
    participant W as Worker and outbox
    participant M as Email provider
    participant C as Candidate browser
    participant O as Orchestrator
    R->>A: create invite (template, candidate email)
    A->>A: org filter, org active and terms accepted, daily invite cap
    alt not active, terms missing or cap reached
        A-->>R: refused with reason (pending invites kept, FR-ORG-08)
    else ok
        A->>A: token 128 bits or more, store hash only, state created, outbox row
        W->>M: send email with single-use link
        alt provider down or daily cap
            W->>W: retry with back-off, mail delayed never lost
        else sent
            W->>A: invite state sent
        end
    end
    C->>A: open link (token)
    A->>A: hash and look up, check expiry and state
    alt expired, revoked, declined or already used
        A-->>C: closed message, recruiter may re-issue (FR-ASM-03)
    else valid
        A-->>C: sign in or register (18 or over) and verify email
        A->>A: verified email must match the invite, else refuse or confirm binding
        A-->>C: consent screen (not pre-ticked), notice version and text
        alt declined
            A->>A: consent record declined, invite declined, nothing else kept
        else accepted
            A->>A: consent record granted (append-only), audit entry, add Candidate role, create attempt (consent then ready)
            A->>O: provision instance in the background (flow 1 steps)
            A-->>C: rules page (time limit, hints, one attempt, no pause), Start button
            alt clock starts at Start (OI-22 option)
                C->>A: Start
                A->>A: wait for instance ready, then started_at and deadline_at set from the server clock
            else clock starts at instance ready (RS-A and RS-C preference)
                A->>A: started_at set when ready, boot time never counts against the candidate
            end
            A-->>C: running, open-the-shop button
        end
    end
```

## 3. Candidate: attempt, capture, submit, expiry, freeze, destroy (FR-SES-02 to 11, FR-INS-05)

```mermaid
sequenceDiagram
    autonumber
    participant C as Candidate
    participant A as API
    participant S as Scheduler and workers
    participant O as Orchestrator
    participant G as gate
    participant R as Recruiter dashboard
    C->>A: open shop (ticket flow) and attack (traffic goes through edge and sidecar)
    Note over A,O: events, milestones and captures follow flow 4
    S->>A: warnings at 15 and 5 minutes left (placeholders) as events and in-page messages
    alt candidate submits early
        C->>A: Submit with confirmation
    else time limit reached (server clock only, FR-SES-02)
        S->>A: attempt expired
        A->>A: auto-submit with everything captured so far
    end
    Note over A: requests after the deadline refused, 60 s grace for submissions already in flight
    A->>O: freeze (final flush of sidecar events, access state frozen)
    O->>G: push access frozen
    G-->>C: shop door shows ended page, no request reaches the shop
    O->>A: report frozen
    S->>S: wait 15 minutes (freeze) for evidence writing to finish
    alt connection lost during the attempt
        Note over C,A: clock keeps running, candidate reconnects to the same instance
    end
    S->>O: destroy instance after the freeze
    O->>O: remove containers and networks, detach edge
    O->>A: report destroyed
    A->>A: attempt submitted then scored then reported (held captures excluded until a human decides)
    A-->>R: live update, results available to recruiter, candidate per OI-15
    alt recruiter or admin cancels while ready or running
        R->>A: cancel (reason)
        A->>O: destroy now
        A->>A: attempt cancelled, audit entry with who and why (FR-SES-07)
    else candidate withdraws consent while running
        C->>A: withdraw
        A->>O: destroy now, lock attempt, notify recruiter, schedule deletion in 7 days (flow 8)
    end
```

## 4. Event ingestion, scoring, live updates (FR-DET-04, 05, FR-SCR-09, FR-LIV-01 to 06)

```mermaid
sequenceDiagram
    autonumber
    participant S as Sidecar
    participant E as edge relay 8081
    participant I as ingest
    participant K as Valkey
    participant W as Scoring worker
    participant P as Postgres
    participant X as outbox relay
    participant L as SSE hub
    participant B as Browser
    S->>E: POST /internal/v1/events (signed with the per-instance key, instance id and seq in the signed part)
    E->>I: forward over the private link (mTLS)
    I->>I: derive the instance key from the master and instance id, verify signature
    alt bad signature or wrong instance id
        I-->>S: 401 and a security event is raised
    else duplicate (instance id, seq)
        I-->>S: 200 ignored (idempotent)
    else new
        I->>K: add to the events stream
        I-->>S: 202
    end
    alt ingest or edge unreachable
        S->>S: buffer (bounded, oldest request summaries dropped first, never flag or state events), retry later
    end
    K->>W: read from the stream (consumer group)
    W->>P: apply catalogue rules to the event
    Note over W,P: flag seen: check attempt state, epoch, activity consistency, may hold. App event: milestone rule. Rule over a window: negative-observation check (FR-DET-06)
    alt event cannot be understood
        W->>K: dead-letter and alert, nothing is scored
    else processed
        W->>P: in one transaction: events row, milestone, evidence (encrypted), score snapshot, domain event (outbox)
        X->>P: read unpublished domain events
        X->>K: publish to live streams (user, org, admin audiences)
        K->>L: blocked read wakes up
        L-->>B: id, event, data
    end
    alt database down
        W->>W: retry, events wait in the stream
    end
    alt browser misses events or Valkey was reset
        B->>L: reconnect with Last-Event-ID
        L-->>B: replay or event resync then the browser loads the snapshot
    end
```

## 5. Flags: derive, inject, capture, paste (D-01, D-02, FR-FLG-01 to 09)

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker (holds the flag key)
    participant O as Orchestrator (no master key)
    participant J as Injector (one-shot)
    participant H as Shop
    participant S as Sidecar
    participant P as Player browser
    participant A as API
    W->>W: derive flags and decoys with the HMAC of instance, challenge, epoch, plus digests
    W->>O: flags and digests over the signed private link
    O->>J: flags on standard input (not environment, not logged)
    J->>H: patch SQLite snapshot and write read-only files, then exit and remove container
    O->>S: digests on standard input
    Note over H,S: image layers hold no flags, CI scan enforces this (FR-FLG-03)
    P->>S: request that triggers the vulnerable path
    S->>H: forward
    H-->>S: response containing a flag-shaped string
    S->>S: hash the string and compare with the digest list
    alt matches a real digest
        S->>A: signed flag_seen (challenge, kind real, capturing request as evidence), never the value
    else matches a decoy digest
        S->>A: signed flag_seen (kind decoy), integrity flag for a human
    else no match
        S->>S: ignore
    end
    S-->>P: response unchanged
    Note over P,A: paste path
    P->>A: POST /attempts/ID/flags with the text (rate limited)
    A->>A: recompute expected flag for the current epoch, constant-time compare, text not stored
    alt correct
        A->>A: credit M3 if activity check passes, else hold for review
    else decoy
        A->>A: integrity flag, no points change
    else matches an earlier epoch of this instance
        A->>A: stale flag logged, no credit
    else valid for another instance
        A->>A: sharing signal naming both instances, not the flag
    else wrong
        A->>A: count toward submission limit (5 per 10 min placeholder), no point penalty
    end
```

## 6. Recruiter and company approval (FR-ORG-01 to 07, FR-ACC-07, FR-ADM-01)

```mermaid
sequenceDiagram
    autonumber
    participant R as Recruiter (first)
    participant A as API
    participant M as Email via outbox
    participant D as Admin
    participant O as Owner
    participant C as Colleague
    R->>A: sign up (work email, company name)
    A->>A: block disposable domains (free-email rule is OI-10), rate limits
    A->>M: verification link (hash stored, 24 hours placeholder)
    R->>A: verify email
    A->>A: recruiter pending_approval, company pending
    D->>A: sign in with password and authenticator code
    A-->>D: approval queue (company, owner, email domain)
    alt approve
        D->>A: approve with reason optional
        A->>A: company active, owner active, audit entry
        A->>M: approval email
        R->>A: accept data-processing terms (company is controller)
        A->>A: record acceptance, invites now allowed
    else reject
        D->>A: reject with written reason
        A->>M: rejection email with the reason
        Note over R,A: may re-apply after the waiting period (OI-11)
    else suspend later
        D->>A: suspend (reason)
        A->>A: members cannot log in to the recruiter area or invite
    end
    C->>A: sign up with a matching domain and ask to join
    alt different domain
        A->>A: refuse or flag for Admin review
    else matching domain
        O->>A: approve or reject request
        A->>A: audit entry, colleague active on approval
    end
```

## 7. Break-glass (D-19, FR-ADM-03, FR-ADM-08, FR-ADM-07)

```mermaid
sequenceDiagram
    autonumber
    participant D as Admin
    participant A as API
    participant K as Key service
    participant N as Alerts (email via outbox)
    participant D2 as Second Admin
    D->>A: open candidate case (admin dashboard shows counts and statuses only)
    A-->>D: no answers, no evidence, no write-ups (FR-ADM-08)
    D->>A: request break-glass with a written reason
    alt reason empty or admin lacks TOTP session
        A-->>D: refused
    else accepted
        A->>A: create break-glass session (named admin, reason, start, expiry per OI-12)
        A->>A: audit entry, then alert goes out in real time
        A->>N: notify other admins immediately
        D->>A: read answers or evidence
        A->>K: unwrap the attempt key for this request only
        A-->>D: content, each read written to the audit log
        alt session expired
            A-->>D: 403, must start again with a new reason
        end
        D2->>A: review afterwards (approve use or raise concern)
        A->>A: review recorded
        alt review overdue
            A->>N: reminder and escalate to admins
        end
    end
```

## 8. Retention and deletion (FR-PRV-04 to 09, 18, FR-SES-10, FR-ACC-09)

```mermaid
sequenceDiagram
    autonumber
    participant S as Scheduler
    participant W as Worker
    participant P as Postgres
    participant K as Key service and keystore
    participant O as Object Storage
    participant M as Email via outbox
    S->>W: hourly retention sweep
    W->>P: attempts past their retention date (default 180 days, range 30 to 365)
    loop each due attempt
        W->>P: delete events, milestones, evidence, hints, score snapshots, integrity flags, instance rows
        W->>K: shred the attempt key (delete row, new keystore snapshot, delete older snapshots)
        K->>O: write the new snapshot, then remove older ones
        W->>P: if the person is being deleted, delete the identity mapping so audit rows identify nobody
        W->>P: audit row "deleted by retention" (pseudonymous)
        W->>M: confirmation emails where required
    end
    alt a job step fails
        W->>P: job_runs failed, Admin alerted, retried next run (target 100 percent on time)
    end
```

```mermaid
sequenceDiagram
    autonumber
    participant C as Candidate
    participant A as API
    participant Co as Company (controller)
    participant Ad as Admin
    participant W as Worker
    C->>A: request deletion
    A->>Co: route the request, candidate sees status
    alt no decision in 14 days (placeholder)
        A->>Co: reminder
        A->>Ad: escalate
    end
    Co->>A: approve (or reject with reason such as legal hold)
    A->>W: execute within 30 days of approval (placeholder), deletion as in the sweep
    W-->>C: confirmation to both parties
    Note over C,A: learner requests go to VulnMart and run at once after the undo window
    C->>A: withdraw consent
    A->>A: lock attempt, destroy running instance, notify recruiter, minimal consent record kept
    A->>A: schedule deletion in 7 days
    alt candidate undoes within 7 days
        C->>A: undo
        A->>A: restore access, cancel the scheduled deletion
    else 7 days pass
        W->>W: delete as in the sweep
    end
```

## 9. Reconciler after an orchestrator crash (FR-INS-05, 07, NFR-AVL-04, spike S-13)

Safety rule first: **the orchestrator never destroys anything because a list is empty or missing.** If it cannot fetch the desired state from the API, it keeps what exists and refuses new creations until the list returns.

```mermaid
sequenceDiagram
    autonumber
    participant O as Orchestrator (restarted)
    participant D as Docker (labels are the fallback truth)
    participant A as API (desired state)
    participant G as gate and edge
    O->>O: boot: do not accept new calls until the first reconcile is done
    O->>D: list containers, networks, volumes by label (instance id, epoch, component, expires)
    O->>A: fetch desired instances for this host
    alt API unreachable or list invalid
        O->>O: safe mode: keep everything, retry, no creations, no deletions
    else list received
        loop each instance id found in Docker or in the desired list
            alt complete container set and desired
                O->>D: re-attach edge to the front network if missing
                O->>G: push access state and epoch
                O->>A: report current state
            else half created (crash during provisioning)
                alt still inside the start time limit and retries remain
                    O->>D: resume or recreate the missing parts (idempotent on id and epoch)
                else
                    O->>D: destroy leftovers
                    O->>A: report failed
                end
            else in Docker but not desired (orphan)
                O->>D: destroy containers and networks
                O->>A: report destroyed
            else desired but missing (for example VM reboot lost memory-backed data)
                alt learner
                    O->>A: report destroyed, learner is told
                else candidate with a running attempt
                    O->>A: report lost, API re-provisions with a new epoch and records an infrastructure fault event for the recruiter (clock unchanged, milestones kept)
                end
            end
        end
        O->>D: remove networks or volumes that have no containers
        O->>O: start normal loop about every minute plus the reaper (expiry and inactivity)
    end
```

## 10. Reset (FR-INS-04, FR-SES-09, FR-TIM-03, FR-FLG-01)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API
    participant W as Worker
    participant O as Orchestrator
    participant G as gate
    B->>A: reset (after a confirmation)
    A->>A: attempt allows it? candidate limit from the template (placeholder 3), attempt not frozen or ended
    alt not allowed
        A-->>B: 409 with the reason (limit reached, attempt over)
    else allowed
        A->>A: epoch + 1, instance state resetting, access epoch + 1, audit and event log, milestones untouched, clock untouched
        A->>O: close access, destroy current containers
        O->>G: access closed
        A->>W: provision again (flow 1 from the flag step)
        W->>O: new flags, digests and event key for the new epoch
        O->>O: create containers and networks, inject, health check
        alt start fails
            O->>A: failed (candidate: infrastructure fault event for the recruiter, retry limit OI-24)
            A-->>B: error shown, instance can be reset again
        else ready
            O->>G: access open with the new access epoch
            O->>A: ready
            A-->>B: ready, old flags now answer stale_epoch if pasted
        end
    end
```
