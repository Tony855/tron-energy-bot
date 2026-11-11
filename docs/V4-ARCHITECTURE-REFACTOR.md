# V4 Architecture Refactor Plan

Status: design baseline only. No production behavior or database schema is changed by this document.
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

Use a modular monolith first, not premature microservices. Keep one deployable service and one MySQL database while enforcing explicit module boundaries. Introduce a separate worker process only after durable job ownership and deployment operations are ready.

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

quoted -> awaiting_payment or accepted -> submitting -> delegated -> completed

Failure paths:
- quoted/accepted -> expired
- submitting -> uncertain when provider timeout makes outcome unknown
- uncertain -> delegated or failed only after provider/chain reconciliation
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

Completed on the isolated refactor branch:
- Runtime configuration validation for JWT secret, DB credentials, HTTP port, DB port, and shutdown deadline.
- Coordinated startup and bounded graceful shutdown for Telegram polling, Socket.IO/HTTP, and the MySQL pool.
- Separate liveness and database readiness probes; server-generated request correlation IDs.
- Additive schema for durable event inbox, event outbox, and leased background jobs.
- MySQL-backed job enqueue/claim/complete/retry/dead-letter primitives with lease recovery and idempotency keys.
- CI workflow for Node.js 22 syntax checks and unit tests.
- Legacy direct-balance energy worker quarantined and regression-tested.

Not yet enabled:
- The inbox/outbox schema and generic queue are primitives only; no production webhook replay dispatcher or background worker is started yet.
- The V4 SQL migration has not been applied to any production database.
- Supplier APIs, automatic fulfillment, automatic deposit credit, and automatic signing remain disabled.
- MySQL integration/concurrency tests and restore/upgrade drills remain required before production use.

## 10. Required next implementation slice

1. Add MySQL integration tests for job lease contention, expiry recovery, dedupe-key collisions, inbox replay, and outbox atomicity.
2. Wire verified webhook hints into the durable inbox and enqueue processing jobs transactionally.
3. Add a separately controllable worker process with bounded concurrency, shutdown/drain, and dead-letter inspection.
4. Publish notifications and Socket.IO events through the outbox only after the associated domain transaction commits.
5. Centralize energy order transitions and all financial settlement through the existing ledger transaction boundary.
