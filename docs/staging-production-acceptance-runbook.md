# Staging and Production Acceptance Runbook

This runbook separates repository/CI evidence from environment-dependent release acceptance. A green GitHub Actions run is necessary, but it is not proof that a live TRON node, supplier, database, or Telegram integration is healthy.

## 1. Release gates

Do not enable automatic financial processing or deploy a schema change to production until all applicable gates below have an owner, timestamp, environment identifier, and retained evidence.

- [ ] Exact release commit is identified; CI is green for that commit.
- [ ] A current encrypted database backup exists and its restore has been rehearsed in an isolated environment.
- [ ] Schema migration has been applied twice in staging and the second application is a no-op/success.
- [ ] Application rollback and database recovery paths are documented and rehearsed.
- [ ] TRON reconciliation has been run against an independent trusted data source.
- [ ] Supplier sandbox lifecycle tests pass without production credentials or funds.
- [ ] Multi-worker concurrency, retry, lease expiry, and restart recovery tests pass.
- [ ] Security review has checked secrets, authorization, webhook signature verification, replay protection, and audit logging.
- [ ] A human release owner has approved the evidence bundle.

## 2. Express 5 / HTTP / Socket.IO smoke tests

Run against staging only, with a dedicated test account and no production funds.

1. Start the service and worker; confirm both report ready and expose no secret values in logs.
2. Verify health/readiness endpoints return the documented status. Confirm readiness becomes unhealthy when required database access is unavailable.
3. Verify login, logout, expired-session rejection, admin authorization, and customer isolation.
4. Verify Socket.IO authenticated connection, reconnect, disconnect cleanup, and authorization on every privileged event. A reconnect must not inherit stale privileges.
5. Deliver a valid signed webhook; verify one Inbox record and one deduplicated background job.
6. Replay the same signed event; verify it is acknowledged idempotently without a second financial effect.
7. Deliver an invalid signature and malformed payload; verify rejection and safe error logging.
8. Stop the process gracefully during idle work and during a leased job; verify the job is recoverable after lease expiry and no duplicate side effect occurs.
9. Verify reverse-proxy headers, HTTPS cookie settings, CORS allowlist, request size limits, and rate limits.

Record request IDs and sanitized logs. Never attach session cookies, webhook secrets, API keys, or full payment payloads to the evidence bundle.

## 3. MariaDB migration, backup, and rollback rehearsal

### Preflight

- Record MariaDB version, schema name, current migration level, table sizes, free disk, and replication/backup state.
- Take an encrypted, access-controlled backup using the organization's approved backup procedure.
- Verify backup integrity and restore it to a separate disposable database before touching staging.
- Confirm application and worker versions are compatible with the additive V4 schema.
- Schedule a maintenance window and ensure a named operator can stop workers.

### Staging migration

1. Stop or pause workers that can mutate the affected tables.
2. Capture pre-migration schema and row counts for `energy_orders`.
3. Apply `sql/migrate_v4_durable_queue.sql` using the deployment's normal migration mechanism.
4. Apply the same migration a second time to verify repeatability.
5. Verify `event_inbox`, `background_jobs`, and `event_outbox` exist with expected indexes.
6. Verify `energy_orders.status` contains the expected states and existing rows remain unchanged.
7. Start the application and worker; run read/write smoke tests with synthetic records.
8. Compare row counts and application error rates with the preflight snapshot.

### Rollback

The V4 migration creates tables and expands an enum. It does not provide a safe automatic down migration. Do not drop the new tables or shrink the enum while newer application code may have written to them.

- If the application release must be rolled back, stop workers first and deploy the previously approved compatible application version.
- Preserve the new tables and enum values until an operator has verified no newer code path depends on them.
- If database restoration is required, restore the pre-migration backup to a separate database first, validate it, then perform a controlled cutover with the release owner. Never overwrite the only copy of the current database.
- Record data written after the backup. Reconcile or replay those records before declaring recovery complete.

## 4. TRON chain reconciliation

Use a separate read-only TRON data source (preferably an independently operated full node or trusted provider distinct from the webhook source).

- Select a bounded block range and record the start/end block numbers and hashes.
- Wait for the application's configured confirmation/finality threshold before treating events as final.
- Independently enumerate relevant TRC20 transfers and compare transaction ID, event/log index, block number/hash, contract, sender, recipient, token amount, and network.
- Compare the independent chain set with Inbox events, deposits, ledger entries, and order state transitions.
- Classify missing, duplicate, orphaned, reorged, and amount-mismatched records. Do not auto-credit or auto-refund from a reconciliation report.
- Verify idempotency keys are stable across webhook replay and scanner replay.
- Have a second operator review all discrepancies and any proposed financial correction.

## 5. Supplier sandbox lifecycle

Use supplier-provided sandbox credentials and non-production wallets only.

- Estimate/quote: validate address, resource amount, price bounds, expiry, and idempotency.
- Submit: verify accepted response and persist the provider reference before acknowledging success.
- Timeout: simulate timeout after request transmission; classify outcome as unknown and query provider status before retrying.
- Duplicate: submit the same idempotency key twice; verify only one supplier order is created.
- Fulfillment: verify provider status and independent on-chain/resource evidence before marking completed.
- Failure/cancel: verify terminal state mapping and that no unsupported state transition is accepted.
- Refund: verify provider refund confirmation and exactly-once ledger reversal.
- Provider outage/rate limit: verify bounded retry, backoff, alerting, and no unbounded queue growth.

Never run these cases against a production supplier account or real customer funds as part of a routine CI job.

## 6. Multi-worker, lease, and recovery tests

Run with at least two independent worker processes and a disposable MariaDB database.

- Burst duplicate webhook deliveries and verify one Inbox event and one deduplicated job.
- Race workers for the same pending job and verify only one valid lease owner.
- Verify wrong and expired lease tokens cannot complete or mutate a job.
- Kill a worker after claim but before side effect; verify lease expiry permits safe recovery.
- Kill a worker after an external request may have been sent; verify reconciliation/status lookup occurs before retrying.
- Restart the database connection during claim/update and verify only transient lock errors retry, with bounded attempts.
- Restart the master process while jobs are pending and while a lease is active; verify eventual recovery without duplicate financial effects.
- Measure queue age, throughput, retry count, dead-letter count, database pool saturation, and p95/p99 processing latency against agreed SLOs.

Do not use production payment or supplier endpoints for load tests.

## 7. Evidence bundle and sign-off

For each run retain:

- Git commit SHA, CI run URL, workflow matrix result, and test report.
- Sanitized deployment configuration (no credentials), application version, Node version, MariaDB version.
- Backup identifier, restore verification result, migration output, and schema diff.
- TRON block range, independent source identity, reconciliation summary, and reviewed discrepancy list.
- Supplier sandbox case IDs and redacted outcomes.
- Worker count, load profile, measured SLOs, failure/recovery timeline, and queue metrics.
- Named operator, reviewer, UTC timestamp, environment, and explicit go/no-go decision.

A missing external dependency or unavailable sandbox is a blocked gate, not a passed test. Keep production automation disabled until all required gates are signed off.
