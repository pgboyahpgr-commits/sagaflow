# SagaFlow v8 — Multi-Tenant Distributed Workflow & Saga Orchestration Engine

A **$0-budget, self-hostable, store-anything-anywhere** visual DAG workflow builder and distributed Saga orchestration engine.

## Features
- **Interactive Visual DAG Studio** (`React 19` + `@xyflow/react` 12) — drag-and-drop workflow builder, 7 step primitives (`Trigger`, `WASM`, `Saga Task`, `HTTP`, `Branch`, `Wait`, `Approval Gate`), topological auto-layout, interactive **Upstream Data Picker** (`{{input.*}}`, `{{steps.*}}`, `{{secrets.*}}`), Blueprint Gallery, 1-click **Export/Import JSON**, immutable versioning (`v1`, `v2`, …), and chaos fault injection.
- **Zero-Mock Real Transactional Engine & Saga Ledger** — every built-in handler (`reserve_inventory`, `charge_payment`, `allocate_credits`, `create_shipment`, `kv_set`, `audit_log`) commits real rows into per-tenant transactional tables (`tenant_inventory`, `tenant_balances`, `tenant_kv`, `saga_ledger`, `webhook_sink_deliveries`). On failure or approval rejection, compensators execute **exact byte-for-byte inverse database rollbacks** with before/after ledger proofs.
- **Crash-Resumable Human-in-the-Loop Approval Gates** — `approval` nodes durably checkpoint upstream outputs and pause runs as `waiting_approval` while holding zero active worker threads. Operators approve/reject inside the **Approvals Inbox** or via external tokenized callback webhooks (`POST /api/callbacks/approval/:token`). Approval resumes downstream steps from checkpoint; rejection triggers full reverse-order Saga compensation.
- **Distributed Saga Orchestrator** — parallel branch fan-out, conditional branching (`skipped` untaken paths), exponential backoff retries, **reverse-order Saga compensation rollbacks**, cooperative cancellation, and **Dead-Letter Queue (DLQ)** with 1-click replay.
- **QuickJS-WASM Isolated Script Sandbox** (`quickjs-emscripten`) — safely run untrusted JS transforms in sealed WebAssembly memory with hard memory limits and CPU interrupt timeouts (zero access to host `process`/`fs`).
- **Store Anything Anywhere (Pluggable Storage & Queue)**:
  - `STORAGE_DRIVER=sqlite` (default): Zero-config embedded SQLite/libSQL with **physical database-per-tenant isolation** (`./data/tenants/<tenantId>.db`).
  - `STORAGE_DRIVER=json`: Human-readable portable JSON files in any directory (local folder, Git repo, Dropbox, Syncthing, NFS).
  - `STORAGE_DRIVER=postgres`: Enterprise PostgreSQL 17 with native **Row-Level Security (RLS)**.
  - `QUEUE_DRIVER=local` (default durable worker pool) or `QUEUE_DRIVER=nats` (NATS JetStream distributed fleet).
- **Resumable Live Tracing, Waterfall Timeline & Prometheus Exporter** — offset-indexed SSE event streams (`GET /api/runs/:id/stream?since=<offset>`), live visual DAG overlay, execution waterfall Gantt chart, live HTTP Sink & Tester, and native **Prometheus / OpenMetrics (`GET /api/metrics`)**.
- **Multi-Tenant Security & Observability** — Self-hosted `scrypt` + HS256 JWT auth, SHA-256 API keys, per-tenant rate limits, cross-tenant `404` non-leakage, latency percentiles (`p50/p95/p99`), and built-in concurrency Load Lab (**benchmarked at 1,000 concurrent zero-mock runs in 8.11s, 123.24 runs/sec / 492.98 real DB+WASM+Sink steps/sec, 100% success**).
- **Automation, Secrets & Triggers** — AES-256-GCM encrypted Secret Vault with `[REDACTED]` scrubbing and least-privilege WASM `allowedSecrets`, `{{input.*}}`/`{{steps.*}}`/`{{secrets.*}}` template chaining, Public Inbound Webhooks (`POST /api/hooks/:tenantSlug/:workflowId`) with HMAC-SHA256 verification, and Durable 5-field UTC Cron Scheduler.
- **Production Operations & CI/CD** — Single-command CLI (`sagaflow start|validate|benchmark`), split-role `ROLE=all|api|worker` scaling, Docker Compose scale profile, Kubernetes HPA manifests (`deploy/k8s/`), GitHub Actions CI/CD (`.github/workflows/ci.yml`), and Vercel serverless configuration (`vercel.json` + `api/index.ts`).

## Quickstart (Local, $0, Zero Dependencies)

Requires **Node.js 20.12+** (22 LTS recommended).

```bash
npm install
npm run build
npm start
```

Open **`http://localhost:4000`** — SagaFlow starts with two pre-seeded tenants (`Acme Commerce` and `Globex Logistics`) and 7 published zero-mock demo workflows (Order Fulfillment Saga, Payment Decline Full Saga Rollback, High-Value Conditional VIP Router, **Wire Transfer Human Approval Gate**, Cross-Tenant Customs Sync, Nested Sub-Workflow Pipeline, and Batch `for_each` Fan-Out).

**Demo admin login:** `admin@sagaflow.local` / `sagaflow123` (seeded only while `SEED_DEMO` is enabled; set `AUTH_MODE=prod` to skip demo seeding automatically).

Optional: copy `.env.example` to `.env` and edit it. `npm start` and the CLI load `.env` automatically.

```bash
cp .env.example .env
```

### Development Mode (Hot Reload)
```bash
# One command: Hono API (:4000) + Vite Studio (:5173, proxies /api -> :4000)
npm run dev

# Or run the two processes separately
npm run dev:api
npm run dev:web
```

### CLI Commands
```bash
# Start with custom options
npm run cli -- start --port 4000 --storage sqlite --data ./data --role all

# Validate any exported workflow JSON from CI/CD
npm run cli -- validate ./my-workflow.sagaflow.json

# Run the real 1,000-concurrent-run benchmark
npm run benchmark
```

### Run Automated Test Suite (43 end-to-end tests)
```bash
npm test
```

## Deploy Anywhere (Docker, Kubernetes & Vercel)

```bash
# Zero-config embedded SQLite (single container)
docker compose up -d --build

# Horizontally scalable split-role mode (PostgreSQL 17 RLS + NATS JetStream + API + 2x Workers)
docker compose --profile scale up -d --build

# Kubernetes production cluster (API Deployment + Worker Deployment with HPA 2-10 pods)
kubectl apply -f deploy/k8s/

# Vercel Serverless + Vite SPA (uses included vercel.json + api/index.ts)
npx vercel --prod
```

### Vercel: demo vs. durable storage

Vercel functions only have a per-instance `/tmp` filesystem, so a deployment without a
database runs as an **ephemeral demo**: every cold instance re-seeds the sample data, and
changes can disappear when instances recycle. The Studio shows an amber `EPHEMERAL DEMO`
badge in that mode.

For durable Vercel storage, attach a PostgreSQL or remote libSQL/Turso database and set:

```bash
vercel env add DATABASE_URL production       # postgres://... or libsql://...
vercel env add LIBSQL_AUTH_TOKEN production  # only for Turso/libSQL
vercel env add SAGAFLOW_MASTER_KEY production # long random value; keeps secrets decryptable
vercel env add SAGAFLOW_JWT_SECRET production # long random value
vercel env add AUTH_MODE production           # prod for a locked-down deployment
vercel env add SEED_DEMO production           # false once you no longer need demo data
vercel --prod
```

> Free-tier Neon (PostgreSQL) and Turso (libSQL) both work and keep the $0 budget.
> Multiple concurrent runs and SSE reconnects are bounded by Vercel's function
> `maxDuration` (60s in `vercel.json`); long-lived workers should run on Docker/Fly/Kubernetes.

### Create a GitHub repository

```bash
git init -b main
git add .
git commit -m "SagaFlow: self-hostable workflow & saga orchestration engine"
gh repo create sagaflow --public --source=. --remote=origin --push
```

The included `.gitignore` excludes `data/` (SQLite databases + `.master.key`), `.env`,
build output, and Vercel state. CI (`.github/workflows/ci.yml`) typechecks, builds, runs all
43 tests, and builds the production Docker image on every push.

## Store Anything Anywhere Examples

```bash
# 1. Default: Physically isolated SQLite DB per tenant
STORAGE_DRIVER=sqlite STORAGE_ISOLATION=db-per-tenant STORAGE_PATH=./data npm start

# 2. Portable JSON folder (sync via Git / Dropbox / NFS)
STORAGE_DRIVER=json STORAGE_PATH=/path/to/my-folder npm start

# 3. Production PostgreSQL (RLS) + NATS JetStream (split role)
ROLE=api STORAGE_DRIVER=postgres DATABASE_URL=postgres://... QUEUE_DRIVER=nats NATS_URL=nats://localhost:4222 npm start
ROLE=worker STORAGE_DRIVER=postgres DATABASE_URL=postgres://... QUEUE_DRIVER=nats NATS_URL=nats://localhost:4222 npm start
```

## Documentation
- API Specification: [`docs/api-contracts.md`](docs/api-contracts.md)
- Architecture & Failure-Recovery Report: [`docs/architecture.md`](docs/architecture.md)
- Submission-Ready Final Project Report (PDF): [`docs/SagaFlow_Final_Report.pdf`](docs/SagaFlow_Final_Report.pdf)
- 1,000-Run Benchmark JSON Data: [`docs/benchmark-1000.json`](docs/benchmark-1000.json)
