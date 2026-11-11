# Batch acceptance status — 2026-11-12

This register separates repository/CI evidence from environment-dependent release evidence. A green GitHub Actions matrix is not a production deployment approval.

| Workstream | Status | Evidence / remaining gate |
|---|---|---|
| 1. TRON historical backfill concurrency | Implemented in PR #10 | Per-wallet/date-range MariaDB advisory lock, explicit already_running result, lock release tests; still require staging process-kill/resume rehearsal |
| 2. Worker lease fencing | Implemented in PR #9 and PR #10 | Lease renewal and token/expiry-fenced Inbox transitions; still require staging multi-worker crash/reclaim and duplicate side-effect rehearsal |
| 3. Express 5 migration | In validation | Isolated Express 5.3.0 branch, updated lockfile, runtime HTTP compatibility tests, full Node/MariaDB matrix; do not deploy until PR checks pass and staging Socket.IO/auth/webhook tests pass |
| 4. Production MariaDB migration and rollback | Blocked — environment evidence required | Need production-like DB version/schema snapshot, approved maintenance window, verified backup, additive migration rehearsal, app rollback rehearsal; never use destructive schema rollback |
| 5. Independent live TRON reconciliation | Blocked — chain evidence required | Need approved independent full-node/explorer data source and a bounded production transaction/wallet range; reconcile contract, Base58 addresses, raw amounts, receipt status, finality and local ledger |
| 6. Supplier sandbox acceptance | Blocked — supplier access required | Need real supplier sandbox endpoint/account and credentials; prove quote expiry, stable idempotency, timeout-to-submission_unknown, acceptance/fulfillment, cancellation/refund and supplier/local reconciliation |
| 7. Production-like load and final security approval | Blocked — staging/SLO evidence required | Need synthetic staging dataset, target hardware, agreed p95/p99/throughput/queue-drain SLOs, concurrency/load run, ledger reconciliation, dependency/security review and human sign-off |

## Mandatory evidence packages

### 4. MariaDB migration and application rollback
- Record production and target MariaDB versions, schema version, release SHA, Node version and service unit checksum.
- Verify encrypted backup, off-host checksum and isolated restore using separately secured recovery material.
- Run additive migration on a production-like copy; capture before/after table/index/enum checks.
- Roll back only the application binary to a version compatible with the additive schema. Do not drop V4 tables or restore over live production as an automatic rollback.
- Record write freeze, reconciliation scope and two-person approval for any disaster-recovery restore.

### 5. Independent TRON reconciliation
- Use a chain data source independent of the application's own indexed transaction table.
- Compare transaction hash and event index, mainnet, configured TRC20 contract, exact case-sensitive Base58Check source/destination, raw token amount/decimals, successful receipt and required confirmation/finality.
- Reconcile missing local rows, unexpected local rows, duplicate event identities, pending recharge orders, credits and ledger entries.
- Export bounded/paginated evidence; a truncated local audit is not a clean reconciliation.

### 6. Supplier sandbox
- Use synthetic users and sandbox funds only.
- Preserve supplier request/response correlation IDs with secrets redacted.
- Prove ambiguous submission timeout is reconciled before any retry; do not blindly resubmit.
- Verify completion only from supplier fulfillment proof and refunds only through idempotent compensating ledger entries.
- Keep supplier execution disabled if any evidence is missing.

### 7. Load and security acceptance
- Test duplicate webhook bursts, concurrent job claims, simultaneous backfills, Outbox dispatch, ledger debit/refund contention, worker crash/restart and transport outage recovery.
- Capture p50/p95/p99, throughput, DB pool saturation, lock waits/deadlocks, queue age/depth, retry/dead-letter counts, CPU/memory/disk and ledger invariants.
- Set target SLOs before running; do not invent throughput targets from CI results.
- Obtain human security approval and document unresolved findings and risk owners.

## Release rule

Items 4–7 remain blocked until evidence is attached from the actual staging/production-like environment and the authorized external services. Keep automatic supplier execution disabled and do not mark the project production-ready solely because repository CI is green.
