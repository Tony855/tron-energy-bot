# Production readiness and controlled rollout runbook

This runbook is a hard gate for the V4 financial-processing release. CI success is necessary but is not production approval. Never enable supplier ordering, automatic signing, or production balance credit merely because this checklist is complete.

## 1. Release scope and safety invariants

- Deploy code and additive schema first while supplier execution remains disabled.
- Keep automatic TRON credit opt-in. A credit requires a confirmed chain receipt, successful execution, the expected TRC20 contract, exact raw amount/decimals, and the assigned deposit wallet.
- Treat `submission_unknown` as an ambiguous external side effect. Do not retry a supplier order until the supplier can definitively reconcile whether it accepted the request.
- Do not mark an order completed without verified fulfillment and a valid transaction hash. Do not mark it refunded until the compensating ledger posting is committed.
- Never put private keys, bot tokens, DB passwords, age identities, webhook secrets, or full customer payloads in tickets, logs, CI artifacts, or shell history.

## 2. Pre-deployment change and environment review

Record the release commit SHA, current production SHA, package-lock SHA, Node version, database server version, schema version, and service-manager unit checksum in the change record.

Before the maintenance window:

1. Confirm a tested off-host backup destination and a separately secured age identity.
2. Confirm free disk space for a full backup plus temporary restore files.
3. Confirm the production DB user can perform the required additive migration and backup operations; do not grant broad privileges permanently just for deployment.
4. Confirm the service account owns the application directory and cannot read unrelated secrets.
5. Confirm the installed Node major is 24 or 26. Do not perform an OS or database major upgrade in the same release window.
6. Confirm supplier execution remains disabled and no production supplier credentials are present unless a separately approved sandbox/production change requires them.
7. Capture current health, pending/dead Inbox/Outbox/job counts, ledger balance totals, and the latest successful backup timestamp.

Stop if any secret is exposed, the backup is not independently recoverable, the schema is unexpected, or the production database version is outside the tested matrix.

## 3. Backup and restore gate

Create a fresh encrypted backup immediately before migration:

```bash
sudo ENV_FILE=/etc/tron-energy-bot.env /opt/tron-energy-bot/scripts/backup.sh
sudo /opt/tron-energy-bot/scripts/verify-backup.sh /var/backups/tron-energy-bot/<UTC_TIMESTAMP>
```

Copy the encrypted backup to the configured off-host destination. Verify remote checksums and record the manifest/checksum, not secret material. For production, set `REQUIRE_OFFSITE_BACKUP=true` in `/etc/tron-energy-bot.env` and configure `RCLONE_REMOTE` plus `RCLONE_PATH`; the backup job then fails closed if the remote is absent, `rclone` is unavailable, or the copy/check fails. Keep the rclone configuration available to the root backup service.

Perform an isolated restore drill on a separate MariaDB instance or a disposable database that cannot be mistaken for production:

```bash
sudo ENV_FILE=/etc/tron-energy-bot.env \
  KEEP_RESTORE_DB=1 \
  /opt/tron-energy-bot/scripts/restore-drill.sh /var/backups/tron-energy-bot/<UTC_TIMESTAMP>
```

Validate table counts, critical ledger totals, user count, latest transaction/order IDs, and application-level read queries against the restored copy. Remove the drill database after evidence is captured. A CI fixture restore is not a production restore.

**Gate:** backup decrypts, archive integrity passes, remote copy is verified, and isolated restore plus application-level checks pass. The five-minute operations monitor checks that the newest local backup has all encrypted artifacts, a manifest, and matching SHA-256 checksums; it does not decrypt the full archive or prove the remote copy on every poll. Perform the explicit decrypt/restore and remote verification above. Otherwise do not migrate.

## 4. Additive database migration and rollback boundary

1. Put the application into the approved maintenance/read-only mode if required by the deployment plan.
2. Stop or pause background workers so no job is claimed while the schema is changing.
3. Run the V4 migration using the intended production database name and credentials.
4. Verify required Inbox, Outbox, background-job tables, indexes, and energy-order enum states.
5. Run the schema guard and read-only application smoke checks.
6. Restart the service and verify readiness, worker spawn, and queue dispatch.

The migration is additive. **Application rollback does not mean destructive schema rollback.** If application smoke checks fail, stop workers and roll back the application release to the last known-good code that is compatible with the additive schema. Do not drop V4 tables, remove enum values, or restore an old database over production as an automatic rollback.

A database restore is a separately approved disaster-recovery action. It requires a verified backup, an explicit recovery-point decision, write freeze, reconciliation of deposits/orders since the backup, and two-person approval. Never restore over the live database as an ad-hoc response.

## 5. systemd and process recovery rehearsal

Run this first on a production-like staging host using the exact service unit and service account:

1. Start the service and confirm the main process, worker process, readiness endpoint, and journal output.
2. Kill only the worker child process (not the main service) and confirm bounded supervisor restart.
3. Force a worker spawn failure and confirm readiness does not report worker-ready.
4. Stop the service normally and confirm shutdown cancels restart timers and leaves no orphan worker.
5. Reboot the staging host and confirm systemd starts the service after network/database readiness.
6. Inspect journal output for secrets, raw webhook bodies, private keys, and customer financial data.

Capture timestamps, service state transitions, restart count, and queue lease recovery evidence. The shipped application and operations-monitor units apply systemd sandboxing (restricted address families, no-new-privileges, private devices/tmp, kernel protection, and read-only filesystem policy except declared state paths); validate the units with `systemd-analyze security` on the target distribution. Do not perform destructive process-kill tests on production during normal customer traffic.

**Gate:** recovery is bounded, no duplicate financial side effect occurs, and stale leases are reclaimed or dead-lettered according to policy.

## 6. Telegram and Socket.IO transport outage rehearsal

On staging, block outbound Telegram and Socket.IO destinations at the network layer for a controlled interval, then restore connectivity.

- Confirm application writes remain committed to the durable Outbox.
- Confirm dispatch attempts record only safe error codes and retry with bounded backoff.
- Confirm expired leases are reclaimed and an old lease token cannot acknowledge a newer claim.
- Restore connectivity and confirm queued notifications drain without duplicate event keys.
- Verify dead-letter visibility and a documented operator replay procedure.
- Confirm customer financial ledger writes are not rolled back because a notification transport is unavailable.

**Gate:** no lost committed event, no duplicate financial mutation, no secret leakage, and queue depth returns to baseline after recovery.

## 7. Load, concurrency, and financial reconciliation

Run load tests only against a disposable/staging MariaDB database with synthetic users and transactions. Never use real customer wallets or supplier endpoints.

Test increasing webhook arrival rates, duplicate webhook bursts, concurrent job claims, Outbox dispatch concurrency, ledger debits/refunds, and worker restarts under load. Record p50/p95/p99 latency, throughput, DB connection saturation, lock waits/deadlocks, queue age/depth, retry/dead-letter counts, CPU, memory, and disk.

Minimum acceptance criteria must be agreed before the run. At minimum:

- No duplicate Inbox event or duplicate ledger posting under replay/concurrency.
- No double debit, negative balance, or unbalanced ledger.
- No job can be completed by a stale lease token.
- No ambiguous supplier submission is retried automatically.
- Queue depth drains after load stops; dead-letter count is explained.
- DB pool saturation and lock waits recover without manual data edits.

Do not invent a universal throughput target. Establish a baseline on production-like hardware, agree a target based on expected peak traffic and headroom, and attach the raw run report.

After the load test, reconcile ledger entries to user balances and reconcile synthetic deposits/orders to their expected terminal states.

The MariaDB integration suite also runs bounded concurrency bursts: 16 simultaneous identical webhook submissions (one Inbox event and one job), 16 identical ledger postings (exactly one posting), 32 concurrent durable-job claimers, and 32 concurrent Outbox claimers. These are correctness/stress regression checks, not a throughput benchmark or a substitute for production-like capacity testing.

## 8. Supplier sandbox and external financial side effects

Supplier integration remains disabled until a real supplier adapter, sandbox endpoint, and credentials are supplied and independently reviewed. For each supplier, demonstrate:

1. Quote amount, currency, network, expiry, and product match.
2. Quote expiry is rechecked immediately before order submission.
3. Idempotency key is stable across retries and supported by the supplier.
4. Timeout after submission becomes `submission_unknown`; no blind resubmission.
5. Reconciliation can prove accepted, rejected, fulfilled, or still unknown.
6. Fulfillment proof is verified before completion.
7. Refund is a ledger-backed compensating entry and is idempotent.
8. Supplier-side transaction IDs and financial reports reconcile with local orders.

Use a low-value sandbox test account and synthetic funds. Record supplier acceptance, fulfillment callback/polling evidence, timeout behavior, duplicate request behavior, cancellation/refund behavior, and reconciliation output. A mock adapter or unit test does not satisfy this gate.

## 9. Go/no-go checklist and evidence

The release owner must mark every item and attach evidence:

- [ ] CI matrix green on the exact release SHA; dependency audit has no high/critical findings.
- [ ] Fresh install and existing-install migration rehearsal pass.
- [ ] Production encrypted backup copied off-host and isolated restore verified.
- [ ] Production-like migration and application rollback rehearsal pass.
- [ ] systemd worker crash/restart/shutdown/reboot rehearsal passes.
- [ ] Telegram and Socket.IO outage/recovery rehearsal passes.
- [ ] Load/concurrency test and ledger reconciliation pass against agreed targets.
- [ ] Supplier sandbox acceptance, ambiguous-timeout reconciliation, fulfillment, and refund pass, or supplier execution remains disabled.
- [ ] Security review and human approval are recorded.
- [ ] Post-deployment smoke checks and monitoring owner are assigned.

If a gate is unavailable, mark it **blocked**, name the external dependency, and keep the PR/release in Draft. Do not convert missing evidence into a pass.


## Finance audit evidence coverage (V4 follow-up)

The read-only finance audit also checks that every paid withdrawal has a chain-verification timestamp and a parseable proof matching the stored transaction hash, destination, exact raw token amount, successful receipt result, and configured USDT contract (when configured). It checks credited referral commissions against their corresponding referral-bonus ledger entry. No finding is auto-repaired.

Audit result sets use bounded queries. Each query fetches one row beyond its display limit; if that sentinel row exists, the report includes `audit_result_truncated` and returns `ok=false`. A truncated report is not a clean audit. Investigate and rerun with a deliberate pagination/export procedure before approval.

The finance audit is an integrity signal, not independent chain finality: it validates the stored withdrawal proof against the stored withdrawal record, but does not re-query the TRON network during each audit. Independent on-chain reconciliation remains a separate release gate.
