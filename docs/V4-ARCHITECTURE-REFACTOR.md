# V4 Architecture Refactor Plan

Status: implementation in progress on an isolated branch; production database remains unchanged.
Target branch: refactor/v4-architecture; base: main.

## 1. Current-state audit

The V3.5 application is a Node.js 22 + Express + grammY + Socket.IO + MySQL modular monolith. It already has valuable foundations: customer-scoped queries, role checks, a transactional balance ledger, encrypted backups, migration scripts, chain verification helpers, and fail-closed supplier placeholders.

Findings that should drive the refactor:

1. Composition and lifecycle are concentrated in src/index.js and src/web.js. HTTP routes, authentication, admin workflows, HTML presentation, event ingestion, and operations are mixed together. The entry point starts HTTP and Telegram polling but lacks coordinated graceful shutdown and explicit readiness.
2. Energy execution is not production-ready. src/providers/energyProvider.js correctly fails closed. In contrast, src/energy-worker.js is a legacy pseudo-provider that directly updates balances outside the ledger, does not claim/lock orders, has no idempotency key, and can debit/refund inconsistently on retries. It must never be activated in production.
3. Chain event ingestion is intentionally incomplete. The webhook accepts a transaction-hash hint and re-verifies confirmed TRC20 events. It is not a native TRON subscription and lacks provider adapters, delivery replay guarantees, and TRX event ingestion in event-only mode.
4. Webhook delivery needs durable semantics: persisted inbox, provider delivery identity, replay protection, retries, dead-letter handling, and reconciliation visibility.
5. Background work is not a durable queue. In-process timers/locks cannot coordinate multiple processes or recover leased work after crashes.
6. Operational diagnostics are basic: liveness and DB health are combined; no explicit readiness/dependency state, structured correlation IDs, metrics, or durable incident state.
7. Tests are mostly unit/source-level. Real MySQL integration tests are needed for transactions, constraints, migration paths, concurrency, and crash/retry behavior before automatic financial execution is enabled.

## 2. Target architecture

Use a modular monolith first, not premature microservices. Keep one deployable service and one MySQL database while enforcing explicit module boundaries. The HTTP service supervises an isolated worker child process; queue ownership and recovery remain database-backed.

Telegram Bot / Admin Web API / Mini App
  -> Interface adapters (HTTP, Telegram, Socket.IO)
  -> Application use cases
  -> Domain modules: Identity/RBAC, Wallets, Chain Monitoring, Deposits, Ledger/Finance, Energy Orders/Pricing, Suppliers, Withdrawals, Notifications, Reporting
  -> Ports/contracts
  -> Infrastructure adapters: MySQL repositories, inbox/outbox/job leases, TRON gateway, supplier APIs
  -> Observability and immutable audit trail

Proposed source layout:

src/app/                 composition root, lifecycle, configuration
src/interfaces/http/     routes, middleware, controllers
src/interfaces/telegram/ commands, callbacks, conversations
src/interfaces/socket/   authenticated admin event gateway
src/modules/identity/    admin/customer identity, sessions, RBAC
src/modules/wallets/     wallet ownership and address pool
src/modules/chain/       event normalization and verification
src/modules/deposits/    recharge state machine and approval
src/modules/ledger/      immutable postings and balance projection
src/modules/energy/      quotes, order state machine, fulfillment
src/modules/suppliers/   provider registry, adapters, routing policy
src/modules/withdrawals/ review, execution, reconciliation
src/modules/notifications/ templates and delivery attempts
src/modules/operations/  health, metrics, backup/ops state
src/infrastructure/      DB, queue, TRON and provider adapters
src/shared/              money, errors, validation, clock, IDs
src/index.js             process entry point only

Do not move every file in one giant commit. Introduce seams and migrate one bounded module at a time, preserving routes and schema until compatibility tests pass.

## 3. Domain workflows and invariants

### Energy order state machine

quoted -> pending_provider -> submitting -> processing -> completed

Failure paths:
- quoted/accepted -> expired
- submitting -> submission_unknown when provider timeout makes outcome unknown
- submission_unknown -> processing/completed/failed only after provider/chain reconciliation
- accepted -> cancelled only before irreversible fulfillment

Rules:
- A quote stores expiry, exact energy amount, duration, recipient, currency, price, supplier, and immutable pricing snapshot.
- Reserve/debit funds atomically through ledger entries and a unique idempotency key; never update users.balance directly in a worker.
- Use unique client order and supplier idempotency keys where supported.
- Never retry ambiguous supplier submission blindly. Query provider status or reconcile on-chain first.
- Refunds are compensating ledger entries exactly once.
- Mark completion only after verifiable delegation/fulfillment, not merely an HTTP 200.
- Every transition is compare-and-set, audited, and timestamped.

### Deposit workflow

detected -> verified -> pending_review -> approved -> credited

Invalid, mismatched, or duplicate transfers go to manual_review/rejected; never silently credit. Verified chain identity binds network, token contract, transaction hash, event index, destination, raw integer amount, decimals, successful receipt, and confirmed/solidified state. Enforce unique (network, tx_hash, event_index, token_contract) identity, separately from customer wallet ownership.

### Ledger invariants

- Ledger postings are append-only; corrections are compensating entries, never edits/deletes.
- Balance projection changes in the same DB transaction as the ledger entry.
- Every financial operation has a deterministic unique idempotency key.
- Store money as integer base units or fixed-precision decimal strings; never use JS floating point.
- Reconciliation detects drift; automatic repair is a separately approved operation.

## 4. Durable event pipeline

Implement a DB-backed inbox/outbox before adding more event providers.

- Inbox: persist raw-body hash, provider, event ID, signature result, received time, processing state, retry count, and safe error code. Unique provider event ID (or deterministic transaction/event key) prevents duplicate delivery.
- Verification: callbacks are hints only; independently query the configured TRON network and verify receipt, contract, event, destination, amount and confirmations.
- Outbox: write notification and Socket.IO publication intents in the same transaction as domain state changes. Dispatcher retries delivery without repeating financial side effects.
- Jobs: workers claim rows using atomic lease tokens and expiry; reclaim expired leases after process death. Use bounded concurrency, exponential backoff with jitter, max attempts, dead-letter state, and manual replay.
- Serialize by wallet/order key where ordering matters; never rely on process-local booleans for cross-process exclusion.

## 5. TRON and supplier boundaries

- Define TronGateway for confirmed transaction lookup, TRC20 events, native TRX transfers, account resources, and delegation verification.
- Make mainnet/testnet explicit and include network identity in every event key.
- Support independent event-source adapters (push/webhook provider and optional polling fallback) without pretending TronGrid REST is a WebSocket subscription.
- Validate webhook HMAC over exact raw bytes, use constant-time comparison, enforce body/time limits, rate-limit per provider, and persist replay/idempotency state.
- Define EnergySupplier methods: health, getQuote, createOrder, getOrderStatus, cancelOrder, verifyFulfillment. Normalize supplier-specific states and redact secrets from stored request/response metadata.
- Supplier routing supports priority/price/capacity, timeouts, circuit breakers, and fallback only before confirmed submission. Ambiguous outcomes require reconciliation.
- Never store supplier credentials or wallet private keys in source, logs, DB event payloads, or browser-visible configuration. This refactor adds no private-key signing.

## 6. Security and operations

- Keep RBAC deny-by-default and enforce authorization at use-case boundaries, not only route middleware.
- Separate /health/live from /health/ready; readiness checks DB and required dependencies with bounded timeouts.
- Validate environment configuration once at startup; fail fast on invalid secrets, network, contract, decimals, and unsafe financial toggles.
- Graceful shutdown: stop accepting new work, stop Telegram polling, stop worker claims, drain in-flight tasks, close Socket.IO/HTTP, then close MySQL.
- Add request/correlation IDs, structured logs, secret/PII redaction, and metrics for queue age, webhook lag, provider latency/error rate, order transitions, chain verification failures, and backup age.
- Audit actor, action, entity, reason, request ID, and safe before/after fields.
- Align CSRF/origin protections, admin session revocation, and WebSocket authorization.

## 7. Migration plan and acceptance gates

### Phase 0 — baseline and safety
- Freeze known-good main baseline and create this refactor branch.
- Run syntax checks and existing tests; record failures before behavior changes.
- Identify unsafe legacy workers and prevent accidental production activation.
- Document route/schema compatibility and migration/rollback procedures.

### Phase 1 — application foundation
- Extract configuration validation and composition root.
- Add lifecycle manager, graceful shutdown, readiness/liveness endpoints, request IDs and safe structured logging.
- Preserve old routes and bot behavior.

### Phase 2 — durable event pipeline
- Add inbox/outbox/job lease migrations.
- Refactor chain ingestion to normalize -> persist inbox -> verify -> apply domain event -> enqueue outbox.
- Add replay, backoff, dead-letter, and reconciliation operations.

### Phase 3 — financial correctness
- Centralize all balance changes through ledger use cases.
- Retire direct-balance legacy worker paths.
- Add MySQL integration/concurrency tests for duplicate deposits, refunds, approvals, withdrawals, and ledger idempotency.

### Phase 4 — energy fulfillment
- Implement supplier adapter contract and a test-only sandbox/mock adapter.
- Add quote/order state machine, reservation/debit/refund, provider routing, uncertain-state reconciliation, and fulfillment verification.
- Real suppliers remain disabled until credentials, API contract, test environment and live acceptance are verified.

### Phase 5 — interfaces and operations
- Split web controllers/routes, Telegram handlers, and Socket.IO gateway from domain use cases.
- Improve provider/order/finance dashboards, customer order tracking, reports and alerts.
- Add backup restore drills and deployment smoke tests.

### Phase 6 — production acceptance
- Unit + MySQL integration + migration upgrade tests.
- Concurrency/replay/failure-injection tests.
- Security review of auth, ownership isolation, webhooks, ledger, supplier secrets, and admin actions.
- Install/upgrade/rollback smoke tests on clean Debian/Ubuntu.
- Merge only when required checks pass. Tests alone do not enable auto-credit or auto-fulfillment.

## 8. Explicit safety constraints

- No private-key custody or automatic signing.
- No fabricated real-time chain subscription; push provider remains an external dependency.
- No automatic deposit credit before independent on-chain verification and configured policy.
- No energy order reported successful without verified delegation.
- No destructive schema rewrite or backfill without encrypted backup, dry-run, ownership checks, and rollback.
- No microservice split until module boundaries, durable jobs, and operational ownership are proven.


## 9. Implementation snapshot (2026-11-11)

Implemented on `refactor/v4-architecture`:
- Runtime configuration validation, coordinated startup/shutdown, request IDs, liveness/readiness probes, and a startup schema guard that refuses to boot before V4 tables and energy-order enum states exist.
- Additive MariaDB tables for event inbox, event outbox, and durable background jobs.
- Signed TRON webhook acceptance: HMAC validation over raw bytes, deterministic transaction identity, Inbox persistence and job enqueue in one transaction, HTTP 202 only after commit.
- Isolated worker re-fetches confirmed TRC20 events and validates receipt success, token contract, decimals, positive raw amount, and wallet ownership before indexing.
- TRON recharge credit requires the verified receipt proof to match transaction hash, exact raw amount, successful receipt, configured contract (when set), and the order's assigned deposit wallet.
- Transfer and recharge credit notifications are transactionally written to Outbox; Telegram and Socket.IO dispatchers use leases, retries, and dead-letter handling.
- Legacy monitor auto-credit path removed; legacy direct-balance energy worker remains quarantined.
- Energy order compare-and-set transition guard added; schema/migration add `submitting` and `submission_unknown`. Ambiguous submissions require reconciliation, completion requires verified fulfillment evidence, and refund transitions require a ledger posting.
- Multi-provider quote router core added with circuit breaker; failover is permitted only after an adapter explicitly reports definitive non-acceptance.
- No real supplier adapters are registered; Mini App energy purchasing remains disabled and fail-closed.
- Admin energy refunds remain ledger-backed, idempotent, and restricted to confirmed failed orders.
- CI run #172 passed Node.js 22 syntax checks and all 101 tests, including MariaDB 11.4 integration, migration idempotency, Inbox replay, queue lease recovery, Outbox lease recovery/dead letters, energy provider routing, order-state guards, and startup schema guard.

## 10. Remaining acceptance gates

1. Integrate the energy order transition service with real supplier adapter contracts, quote expiry, payment reservation/debit, provider status reconciliation, verified fulfillment, and ledger refunds. Supplier execution remains disabled until API credentials and sandbox/live acceptance are supplied.
2. Add worker process crash/restart tests, provider callback authentication/replay tests, concurrent ledger posting/refund tests, and Outbox delivery failure injection.
3. Perform a production-like migration rehearsal against a sanitized schema snapshot, then verify application rollback compatibility. The additive Inbox/Outbox/job tables should remain during application rollback; do not drop them while events or jobs exist.
4. Perform encrypted backup and restore verification, install/upgrade/rollback smoke tests, and bounded load/stress tests. These cannot be claimed from CI alone.
5. Complete final security review, inspect current-head CI, and merge only after all gates pass.

## 11. Deployment and rollback constraints

- The V4 migration has not been applied to production. Take and verify an encrypted backup before any deployment migration.
- Deploy the application only after the migration is applied and checked. Do not enable automatic credit or supplier fulfillment merely because the worker is running.
- Application rollback should use the prior application image while retaining additive event tables. Before rollback, drain or pause workers and reconcile any energy orders in `submitting` or `submission_unknown`; never blindly resubmit or refund uncertain provider orders.
- Do not drop Inbox, Outbox, or job tables as part of routine rollback. Their durable records are required for replay and audit.
- No private-key custody, automatic signing, or real supplier execution is enabled by this refactor.


## Worker process supervision (follow-up)

The API process supervises the durable worker child process. Unexpected child exit or spawn errors trigger bounded exponential restart delays controlled by `WORKER_RESTART_BASE_MS` and `WORKER_RESTART_MAX_MS`. The number of automatic retries is capped by `WORKER_MAX_RESTARTS`; after the cap, worker health becomes `failed` and readiness remains HTTP 503 until the service is restarted or an operator intervenes. Graceful shutdown cancels pending restarts and does not relaunch the worker.

`/health/ready` now requires both a reachable database and a worker process that emitted its successful spawn event. This is process-level readiness, not a substitute for a worker heartbeat or proof that an external supplier is available. Automated tests cover unexpected exit, bounded backoff, retry exhaustion, child spawn errors, and no restart after intentional shutdown.


## Financial concurrency follow-up

The ledger posting idempotency guard now binds a reused key to the complete posting identity: user, normalized amount, entry type, reference type, and reference ID. Reusing a key for a different business operation is rejected instead of being treated as a successful duplicate. MariaDB integration coverage now races duplicate credits and refunds, races two debits that together exceed the account balance, and verifies that only one debit succeeds and the balance never becomes negative. These are test-environment checks; production concurrency and load rehearsal remain required.


## Worker process and Outbox transport follow-up

- Telegram and Socket.IO outbox consumers now share `dispatchOutboxOnce`, so transport errors are recorded against the current lease and returned to the durable retry/dead-letter policy. A lost lease acknowledgement is logged and is not treated as a second delivery attempt.
- Unit tests cover successful acknowledgement, transport failure/retry recording, empty queues, and lost acknowledgements.
- A process-level test launches real Node child processes, forces the first worker process to exit unexpectedly, and verifies that the supervisor starts a replacement process.
- These tests exercise the supervisor and dispatch abstraction in CI. They do not replace a deployment-level rehearsal with the production service manager, real Telegram/Socket.IO endpoints, network partitions, or shutdown under load.


## Supplier quote expiry guard (follow-up)

Supplier quote validity is rechecked immediately before every create-order call. A quote that expired after display is skipped and never submitted; if no fresh quote remains, the router returns `PROVIDER_QUOTE_EXPIRED`. This is an application-side guard and does not replace supplier-side expiry enforcement or quote locking.
