# SagaFlow — Distributed Workflow & Saga Orchestration Architecture & Failure-Recovery Report

## 1. Architectural Overview
SagaFlow is a **$0-budget, self-hostable, multi-tenant Workflow & Saga Orchestration Engine** designed to run identically on a developer laptop (zero external services) and across horizontally scaled containers (PostgreSQL RLS + NATS JetStream).

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SagaFlow Studio (React 19 + @xyflow/react)          │
│  Visual DAG Canvas · Live Run Trace Overlay · WASM Tester · Load Lab    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Same-Origin HTTP + Resumable SSE
┌───────────────────────────────▼─────────────────────────────────────────┐
│                    Hono API Gateway (apps/api)                          │
│  Unified Error Envelope · SHA-256 API Keys · Dev Tenant Auth · Quota RL │
└──────────────┬───────────────────────────────────────┬──────────────────┘
               │                                       │
┌──────────────▼──────────────────┐      ┌─────────────▼──────────────────┐
│  Pluggable StorageAdapter       │      │  Saga Orchestrator & Queue     │
│  ("Store Anything Anywhere")    │◄────►│  · LocalDurableQueue (default) │
│  · SQLite db-per-tenant (def.)  │      │  · NATS JetStream (scale mode) │
│  · Portable JSON Folder Store   │      │  · Parallel DAG Scheduler      │
│  · PostgreSQL 17 with Native RLS│      │  · Reverse Saga Compensator    │
└─────────────────────────────────┘      │  · QuickJS-WASM Script Sandbox │
                                         │  · Offset-Indexed RunEventBus  │
                                         └────────────────────────────────┘
```

## 2. Multi-Tenant Data Isolation Strategies
SagaFlow implements **three isolation strategies** behind one `StorageAdapter` contract:
1. **Physical Database-per-Tenant (`STORAGE_DRIVER=sqlite`, `STORAGE_ISOLATION=db-per-tenant` — Default):**
   - `control.db` stores tenant registry, memberships, and SHA-256 API key hashes.
   - Each tenant gets an independent WAL-mode SQLite file (`./data/tenants/<tenantId>.db`).
   - Cross-tenant SQL joins are physically impossible; per-tenant backup, export, or GDPR deletion is a single file operation.
   - A per-database write mutex serializes concurrent writes on each handle to eliminate `SQLITE_BUSY` errors under parallel DAG fan-out and 1,000-run stress tests.
2. **Portable Directory JSON Store (`STORAGE_DRIVER=json`):**
   - Stores each tenant in atomic-write (temp + rename) human-readable JSON files in any directory (local disk, Git repository, Dropbox, Syncthing, NFS).
3. **PostgreSQL Native Row-Level Security (`STORAGE_DRIVER=postgres`):**
   - Enables `ROW LEVEL SECURITY` on all tenant tables and sets `SET LOCAL app.current_tenant = $1` inside every transaction so the database engine enforces tenant isolation independent of application query bugs.
4. **Non-Leaking Cross-Tenant API Semantics:** Accessing another tenant's workflow or run ID always returns HTTP `404`, never `403`.

## 3. Saga State Machine & Failure-Recovery Semantics
1. **DAG Scheduling & Parallel Fan-Out:**
   - Before publishing, `validateWorkflowGraph` runs Kahn's topological sort + DFS cycle attribution to reject cycles, self-loops, duplicate IDs, and dangling edges.
   - At runtime, all nodes whose upstream dependencies are satisfied run concurrently (`Promise.all`).
   - `condition` nodes evaluate expressions inside QuickJS-WASM and deactivate untaken outgoing edges; unreachable downstream branches automatically transition to `skipped`.
2. **Idempotent Run Creation:**
   - `POST /api/workflows/:id/runs` requires `Idempotency-Key`. A unique database constraint on `(tenant_id, workflow_id, idempotency_key)` guarantees duplicate requests return `200` with the original run rather than spawning duplicate executions.
   - Runs are persisted to storage **before** enqueueing to prevent lost jobs.
3. **Exponential Backoff Retries:**
   - Each step supports configurable `retryPolicy: { maxAttempts, initialDelayMs, backoffMultiplier }`.
   - Every attempt is durably persisted with timestamps, latency, logs, and errors.
4. **Reverse-Order Saga Compensation:**
   - When any step exhausts its retry budget:
     1. In-flight sibling branches receive an `AbortSignal` to halt cleanly.
     2. The run transitions to `compensating`.
     3. Previously `succeeded` steps with registered compensators execute in **strict reverse completion order** (e.g., `revert_credits` before `release_inventory`), each with retry protection and `kind: "compensate"` attempt records.
     4. If all compensations succeed, the run terminates as **`compensated`**. If no compensators exist or compensation fails, it terminates as **`failed`**.
5. **Dead-Letter Queue (DLQ) & Replay:**
   - Every terminal failure/compensation records a structured DLQ entry capturing the failed node, error payload, and original input for 1-click idempotent replay (`POST /api/dlq/:id/replay`).
6. **Crash Recovery:**
   - On startup, `LocalDurableQueue` scans persisted `pending`, `running`, and `compensating` runs across all tenant stores and re-enqueues them automatically.

## 4. Isolated User Script Sandbox (QuickJS-WASM)
Instead of `node:vm` (insecure) or `isolated-vm` (maintenance mode, C++ native build fragility), SagaFlow embeds **QuickJS compiled to WebAssembly (`quickjs-emscripten`)**:
- Runs inside sealed WASM linear memory with zero access to Node `process`, `fs`, `require`, `fetch`, or host V8 prototypes.
- Enforces hard memory limits (`setMemoryLimit`, default 16 MB) and wall-clock CPU interrupts (`setInterruptHandler`, default 1.5–2 s) so `while (true) {}` and allocation bombs terminate cleanly with structured errors.
- Exchanges data strictly as serialized JSON strings across the host/WASM boundary.

## 5. Resumable Live Execution Tracing (Durable SSE)
Every state transition appends an offset-indexed event (`#1, #2, ...`) to storage before publishing to subscribers. `GET /api/runs/:id/stream?since=<offset>` (and `Last-Event-ID`) replays missed events from disk and seamlessly switches to real-time push — surviving page refreshes and network drops with zero lost step transitions.

## 6. Encrypted Secrets Vault, Template Chaining, Webhooks, Cron & Self-Hosted Auth
- **AES-256-GCM Secret Vault (`SecretCipher`)**: Per-tenant secrets are encrypted at rest with random 96-bit IVs and 128-bit GCM authentication tags using `SAGAFLOW_MASTER_KEY` (or a `0600` local `.master.key` file). Secrets are write-only via REST, granted to QuickJS-WASM scripts strictly via least-privilege `config.allowedSecrets`, interpolated via `{{secrets.*}}`, and **automatically redacted (`[REDACTED]`)** from all step outputs, logs, errors, and SSE streams before persistence.
- **Template Variable Chaining**: `resolveTemplates` supports `{{input.*}}`, `{{steps.<nodeId>.*}}`, `{{secrets.*}}`, and `{{env.*}}` across HTTP requests and task payloads while preserving native JSON types for standalone expressions.
- **Public Inbound Webhooks (`POST /api/hooks/:tenantSlug/:workflowId`)**: Accepts external payloads with constant-time HMAC-SHA256 verification (`X-SagaFlow-Signature` / `X-Hub-Signature-256`), per-tenant rate limiting, and `Idempotency-Key` deduplication.
- **Durable Cron Scheduler (`CronScheduler`)**: Zero-dependency 5-field UTC cron engine shared between backend and Studio UI. Minute-scoped deterministic idempotency keys (`cron_<scheduleId>_<YYYY-MM-DDTHH:MM>`) guarantee exactly-once firing even across multiple `ROLE=worker` replicas.
- **Self-Hosted Authentication**: Native `scrypt` password hashing (per-user random 16-byte salt) and HS256 JWT sessions (`Authorization: Bearer` + `HttpOnly; SameSite=Lax` cookie), complementing SHA-256 API keys and `AUTH_MODE=dev` local convenience.
- **Split-Role Horizontal Scaling & Kubernetes Auto-Scaling**: Setting `ROLE=api` separates stateless HTTP/UI/SSE ingestion from `ROLE=worker` execution pods (`deploy/k8s/03-worker-deployment-hpa.yaml` autoscales workers from **2 to 10 pods** on CPU/memory pressure).

## 7. Zero-Mock Persistent State, Human-in-the-Loop Approvals & Prometheus Telemetry
- **Zero-Mock Transactional Tables**: Each isolated tenant database maintains live operational tables (`tenant_inventory`, `tenant_balances`, `tenant_kv`, `saga_ledger`, `webhook_sink_deliveries`, and `approvals`). Every built-in Saga handler executes real SQL/JSON mutations and records atomic before/after proofs to `saga_ledger`. Compensators (`release_inventory`, `refund_payment`, `release_credits`, `cancel_shipment`, `http_compensate`) restore exact pre-run balances and stock quantities.
- **Crash-Resumable Human-in-the-Loop Approval Gates (`approval`)**: When a DAG reaches an `approval` node, the orchestrator checkpoints all completed upstream step outputs, persists a tokenized `ApprovalRequest`, sets step & run status to `waiting_approval`, and releases its worker slot completely (zero held threads). On approval (`POST /api/approvals/:id/decide` or public webhook `POST /api/callbacks/approval/:token`), the orchestrator re-hydrates completed checkpoints and resumes downstream DAG execution. On rejection, the engine immediately invokes reverse-order Saga compensation across all previously succeeded steps.
- **Prometheus / OpenMetrics (`GET /api/metrics`)**: Exports live multi-tenant counters (`sagaflow_runs_total`, `sagaflow_dlq_open`, `sagaflow_approvals_pending`, `sagaflow_rate_limit_used`), latency quantiles (`sagaflow_run_latency_ms`), and process RSS memory for zero-config Grafana/Prometheus scraping.

## 8. Measured 1,000-Concurrent-Run Zero-Mock Benchmark Results
Executed via `node apps/api/dist/cli.js benchmark --runs 1000 --concurrency 50 --json docs/benchmark-1000.json` on a single 4-step zero-mock DAG (`trigger -> QuickJS-WASM script -> parallel real DB reserve_inventory + real persisted HTTP Webhook Sink` with AES-256-GCM secret decryption, Saga Ledger persistence, and SQLite WAL event storage):

| Metric | Measured Result |
|---|---|
| Total Concurrent Runs | **1,000 runs** (4,000 real DB + WASM + HTTP Sink steps) |
| Worker Pool Concurrency | 50 concurrent workers (`SQLite db-per-tenant` WAL mode) |
| Completion / Success Rate | **1,000 / 1,000 (100.00%)** — zero `SQLITE_BUSY`, zero lost events |
| Enqueue Time (1,000 durable runs) | **0.51 s** (512 ms) |
| Total End-to-End Wall Time | **8.11 s** (8,114 ms) |
| Sustained Throughput | **123.24 runs/sec** (**492.98 real durable steps/sec**) |
| Run Latency (min / avg / p50 / p95 / p99 / max) | **166ms / 386ms / 350ms / 587ms / 1,014ms / 1,056ms** |
| Tenant Database Size on Disk | **10.9 MB** (10,900 KB including all ~15,000 SSE events & Saga Ledger proofs) |
| Peak Process RSS | **604.8 MB** |
