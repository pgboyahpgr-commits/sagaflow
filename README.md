# SagaFlow v8

**A self-hostable, multi-tenant distributed Workflow & Saga Orchestration Engine — with a visual DAG studio, real compensating transactions, and zero required infrastructure.**

[![Live demo](https://img.shields.io/badge/live%20demo-sagaflow.vercel.app-22e55c?logo=vercel&logoColor=white)](https://sagaflow.vercel.app)
[![Version](https://img.shields.io/badge/version-8.0.0-22e55c)](https://github.com/pgboyahpgr-commits/sagaflow)
[![Node](https://img.shields.io/badge/node-%3E%3D20.12-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-a855f7)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-43%20passing-22e55c)](tests/sagaflow.test.ts)

**[Live demo →](https://sagaflow.vercel.app)** · `admin@sagaflow.local` / `sagaflow123`

> The Vercel demo runs on ephemeral JSON storage — it re-seeds itself per serverless instance and shows an
> amber `EPHEMERAL DEMO` badge. Everything below runs with durable SQLite or PostgreSQL when self-hosted.

---

## Table of contents

- [What it does](#what-it-does)
- [Quickstart](#quickstart)
- [The demo workflows](#the-demo-workflows)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [API in 60 seconds](#api-in-60-seconds)
- [Deployment](#deployment)
- [Testing and CI](#testing-and-ci)
- [Documentation](#documentation)
- [License](#license)

---

## What it does

SagaFlow executes long-running, multi-step business transactions as a **DAG of steps**, and when a step fails it
**compensates in reverse order** so your data ends up exactly where it started. It is not a mock: the built-in
handlers commit real rows into per-tenant tables and the compensators perform real inverse writes.

| Capability | Detail |
|---|---|
| **Visual DAG studio** | React 19 + `@xyflow/react`, 7 node primitives (Trigger, WASM, Saga Task, HTTP, Branch, Wait, Approval Gate), auto-layout, upstream data picker, blueprint gallery, JSON import/export, immutable versions, chaos fault injection |
| **Real saga semantics** | Parallel fan-out, conditional skips, exponential backoff retries, reverse-order compensation, cooperative cancellation, dead-letter queue with one-click replay |
| **Zero-mock state** | `reserve_inventory`, `charge_payment`, `allocate_credits`, `create_shipment`, `kv_set`, `audit_log` write to `tenant_inventory`, `tenant_balances`, `tenant_kv`, `saga_ledger`; rollbacks restore exact before/after values with ledger proofs |
| **Human-in-the-loop** | `approval` nodes checkpoint upstream output and park the run as `waiting_approval` using no worker threads; approve in the inbox or via a tokenized callback URL |
| **Sandboxed scripting** | QuickJS compiled to WebAssembly — untrusted JS transforms run with hard memory limits and CPU timeouts, zero host `process`/`fs` access |
| **Pluggable storage & queue** | SQLite (db-per-tenant), portable JSON folders, PostgreSQL 17 with RLS; `local` durable worker pool or NATS JetStream |
| **Live tracing** | Resumable SSE streams (`Last-Event-ID` / `?since=`), DAG overlay, waterfall timeline, HTTP sink tester, Prometheus `/api/metrics` |
| **Multi-tenant security** | `scrypt` password hashing, HS256 JWT cookies, SHA-256 API keys, per-tenant rate limits, cross-tenant `404` non-leakage, RBAC, AES-256-GCM secret vault with `[REDACTED]` scrubbing |
| **Automation** | Public inbound webhooks with HMAC-SHA256 verification, 5-field cron scheduler with minute-scoped idempotency, template chaining (`{{input.*}}`, `{{steps.*}}`, `{{secrets.*}}`) |

Benchmark from the included harness: **1,000 concurrent zero-mock runs in 8.11 s — 123.24 runs/s, 492.98 real DB + WASM + sink steps/s, 100% success** ([data](docs/benchmark-1000.json)).

---

## Quickstart

Requires **Node.js 20.12+** (22 LTS recommended).

```bash
npm install
npm run build
npm start
```

Open **http://localhost:4000** and sign in with `admin@sagaflow.local` / `sagaflow123`.

On first boot SagaFlow creates two tenants (`Acme Commerce`, `Globex Logistics`) and seven published demo
workflows. Demo seeding is on by default for local runs and is skipped automatically when `AUTH_MODE=prod`.

### Development (hot reload)

```bash
npm run dev        # Hono API on :4000 + Vite studio on :5173, /api proxied for you
```

Or run the halves separately: `npm run dev:api` and `npm run dev:web`.

### CLI

```bash
npm run cli -- start --port 4000 --storage sqlite --data ./data --role all
npm run cli -- validate ./my-workflow.sagaflow.json   # CI-friendly workflow linter
npm run benchmark                                     # real 1,000-run concurrency benchmark
```

---

## The demo workflows

Seeded so you can watch each engine feature end-to-end:

| Workflow | Demonstrates |
|---|---|
| Order Fulfillment Saga | Parallel fan-out, retries, happy-path ledger writes |
| Payment Decline — Full Saga Rollback | Permanent failure → reverse-order compensation with byte-exact restore |
| High-Value Approval Router | Conditional branch + wait node |
| Wire Transfer Approval Gate | Human-in-the-loop checkpoint, approve/reject, resume or compensate |
| Cross-Tenant Customs Sync | HTTP sink steps and tenant-scoped state |
| Nested Sub-Workflow Pipeline | Parent → child saga with `childRunId` lineage and depth guard |
| Batch Order Line Fan-Out | `for_each` concurrency with rollback of partial batches |

---

## Configuration

Everything is environment-driven; `.env` is loaded automatically. Start from `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `STORAGE_DRIVER` | `sqlite` | `sqlite` \| `json` \| `postgres` |
| `STORAGE_PATH` | `./data` | Data directory for sqlite/json drivers |
| `STORAGE_ISOLATION` | `db-per-tenant` | `db-per-tenant` or shared database |
| `DATABASE_URL` | — | PostgreSQL / libSQL connection string |
| `QUEUE_DRIVER` | `local` | `local` durable pool or `nats` JetStream |
| `NATS_URL` | — | NATS server for distributed workers |
| `ROLE` | `all` | `all` \| `api` \| `worker` — split API and worker fleets |
| `WORKER_CONCURRENCY` | `8` | Parallel step executions per worker |
| `AUTH_MODE` | `dev` | `dev` (demo seeding) or `prod` (locked down) |
| `SEED_DEMO` | auto | Force demo tenant/workflow seeding on or off |
| `SAGAFLOW_JWT_SECRET` | generated | HS256 signing key for session cookies |
| `SAGAFLOW_MASTER_KEY` | generated | AES-256-GCM key for the secret vault |
| `SAGAFLOW_VERSION` | `8.0.0` | Reported by `/api/health` and OpenAPI |

> Self-hosting for real? Persist `data/` (it contains the SQLite databases **and** `.master.key`) or set
> `SAGAFLOW_MASTER_KEY` + `SAGAFLOW_JWT_SECRET` explicitly so restarts and secret decryption survive.

---

## Architecture

```
            Browser (React 19 + Vite SPA)
                       │  REST + SSE
             ┌─────────▼─────────┐
             │   Hono API        │  auth · RBAC · validation · rate limits
             │  ROLE=api|all     │
             └────┬─────────┬────┘
      enqueue run │         │ persist run/step/ledger
         ┌────────▼──┐   ┌──▼──────────────────────────┐
         │  Queue    │   │  Storage adapter            │
         │ local|nats│   │  sqlite | json | postgres   │
         └────────┬──┘   └─────────────────────────────┘
                  │
        ┌─────────▼──────────┐
        │ Orchestrator       │  DAG walk · retries · fan-out
        │ ROLE=worker|all    │  compensation · approvals
        └─────────┬──────────┘
                  │
        ┌─────────▼──────────┐
        │ Step handlers      │  real DB writes · HTTP sinks
        │ + WASM sandbox     │  QuickJS, memory & CPU caps
        └────────────────────┘
```

Runs are persisted **before** they are enqueued, so a crash between the two can never lose work; workers claim
steps with leases and resume interrupted runs on boot.

---

## Project layout

```
sagaflow/
├── apps/
│   ├── api/          Hono server, routes, OpenAPI, CLI        (@sagaflow/api)
│   └── web/          React + Vite operator studio             (@sagaflow/web)
├── packages/
│   ├── shared/       Types + zod schemas                      (@sagaflow/shared)
│   ├── engine/       Orchestrator, storage, queue, handlers   (@sagaflow/engine)
│   └── sdk/          Typed client for your own services       (@sagaflow/sdk)
├── api/index.ts      Vercel serverless entry
├── deploy/           Kubernetes manifests
├── docs/             API contracts, architecture, report
├── tests/            43 end-to-end tests (vitest)
└── scripts/          Dev runner
```

---

## API in 60 seconds

```bash
# 1. Sign in (stores a session cookie)
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"admin@sagaflow.local","password":"sagaflow123"}' \
  http://localhost:4000/api/auth/login

# 2. Start a run — Idempotency-Key makes retries safe
curl -b cookies.txt -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"input":{"orderId":"ORD-1001","customerId":"CUST-7","amount":199}}' \
  http://localhost:4000/api/workflows/wf_order_fulfillment/runs

# 3. Follow it live (resumable: send Last-Event-ID or ?since=)
curl -b cookies.txt -N http://localhost:4000/api/runs/<runId>/stream

# 4. Operate it
curl -b cookies.txt http://localhost:4000/api/runs/<runId>
curl -b cookies.txt -X POST http://localhost:4000/api/runs/<runId>/cancel
curl -b cookies.txt http://localhost:4000/api/metrics      # Prometheus / OpenMetrics
```

Interactive docs: **`/api/docs`** · machine-readable spec: **`/api/openapi.json`**
(also exported by the `@sagaflow/sdk` client).

Trigger from outside with a signed inbound webhook:

```bash
curl -H 'x-sagaflow-signature: sha256=<hmac>' -H 'content-type: application/json' \
  -d '{"orderId":"ORD-2002"}' \
  http://localhost:4000/api/hooks/acme-commerce/wf_order_fulfillment
```

---

## Deployment

| Target | Command | Notes |
|---|---|---|
| Local / VPS | `npm ci && npm run build && npm start` | SQLite on disk, single process |
| Docker | `docker compose up -d --build` | Multi-stage image, healthcheck, volume for `data/` |
| Docker (scale) | `docker compose --profile scale up -d --build` | PostgreSQL RLS + NATS JetStream + API + 2 workers |
| Kubernetes | `kubectl apply -f deploy/k8s/` | API and worker deployments with HPA (2–10 pods) |
| Render / Fly.io | `render.yaml` / `fly.toml` | Blueprint and Fly config included |
| Vercel | `npx vercel --prod` | Serverless API (`api/index.ts`) + static SPA |

### Vercel notes

Vercel functions only get a per-instance `/tmp`, so the public demo is an **ephemeral demo**: JSON storage at
`/tmp/sagaflow-data`, re-seeded on cold start, with data that can reset between instances. The studio badges that
state so nobody mistakes it for durable.

For a durable Vercel deployment add a database and re-deploy:

```bash
vercel env add DATABASE_URL production        # postgres://… (Neon free tier works)
vercel env add SAGAFLOW_MASTER_KEY production # long random value
vercel env add SAGAFLOW_JWT_SECRET production # long random value
vercel env add AUTH_MODE production           # prod
vercel env add SEED_DEMO production           # false
vercel --prod
```

SSE reconnects and concurrent runs are bounded by the function `maxDuration` (60 s in `vercel.json`); for
long-lived workers prefer Docker, Fly, or Kubernetes.

Fonts (Inter, JetBrains Mono) are self-hosted via `@fontsource` and bundled into `/assets`, so the UI renders
identically offline, in Docker, and on Vercel with no third-party CDN request.

---

## Testing and CI

```bash
npm run typecheck   # strict TypeScript across all 5 workspaces
npm run build       # shared → engine → sdk → api → web
npm test            # 43 end-to-end tests
```

The suite exercises the real stack over HTTP: multi-tenant isolation, saga rollback with byte-exact restore,
idempotency, cancel, DLQ replay, nested sub-workflows, approvals, secrets, webhooks, cron, JWT auth, SSE resume,
OpenAPI, and the SDK.

A GitHub Actions pipeline that runs typecheck → build → all 43 tests → CLI benchmark on every push, then builds
the production Docker image, ships as `.github/workflows/ci.yml` and can be enabled by pushing it with a token
that carries the `workflow` scope:

```bash
gh auth refresh -h github.com -s workflow && git add .github/workflows/ci.yml && git commit -m "ci: add workflow" && git push
```

---

## Documentation

- [API contracts](docs/api-contracts.md)
- [Architecture & failure-recovery report](docs/architecture.md)
- [Project report (PDF)](docs/SagaFlow_Final_Report.pdf)
- [1,000-run benchmark data](docs/benchmark-1000.json)
- [UI design brief](docs/UI_AGENT_DESIGN_BRIEF.md)

---

## License

[MIT](LICENSE) © 2026 pgboyahpgr-commits
