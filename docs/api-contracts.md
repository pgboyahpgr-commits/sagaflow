# SagaFlow — API Contract (v1.1 + Self-Hosted Extensions)

> Source of truth for shared schemas, statuses, and types: `packages/shared` (`@sagaflow/shared`).

## 1. Conventions
- **Base URL:** Browser calls relative `/api/...` (same-origin, zero CORS). Direct server default: `http://0.0.0.0:4000`.
- **Format:** `application/json`, `camelCase` fields, `lowercase snake_case` error & issue codes, ISO 8601 UTC timestamps, opaque prefixed string IDs (`wf_...`, `ver_...`, `run_...`, `dlq_...`, `key_...`, `ten_...`).
- **Tenant Isolation:** Every workflow, run, DLQ, API key, and admin route is strictly tenant-scoped on the server. Resources belonging to another tenant return `404` (never `403`).
- **Authentication:**
  - Production & programmatic clients: `X-Api-Key: sf_live_...` (verified via SHA-256 hash lookup).
  - Dev mode (`AUTH_MODE=dev`): `X-Tenant-Id` + `X-User-Id` verified against the tenant membership table.
- **Rate Limiting:** Per-tenant sliding window returning `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (`429 rate_limit_exceeded` when exceeded).
- **Unified Error Envelope (all non-2xx responses):**
  ```json
  {
    "code": "invalid_workflow_graph",
    "message": "Workflow graph has 1 validation issue(s).",
    "errors": [
      { "code": "cycle", "message": "Workflow graph contains a cycle...", "nodeId": "charge", "edgeId": "e-back" }
    ]
  }
  ```

## 2. Shared Graph Model (`WorkflowDefinition`)
```json
{
  "name": "Order fulfillment",
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger",
      "label": "Order received",
      "position": { "x": 80, "y": 130 },
      "config": {}
    }
  ],
  "edges": [
    { "id": "e-trigger-reserve", "from": "trigger", "to": "reserve", "condition": "always" }
  ]
}
```
- **Step Kinds:** `trigger | http_request | condition | wait | script | custom_task | approval`
- **Edges:** `from` / `to` (frontend maps React Flow `source`/`target` at its boundary).
- **Limits:** `name` 1–160 chars; `id` 1–100 chars; max 500 nodes; max 2,000 edges.
- **Issue Codes:** `duplicate_node_id | duplicate_edge_id | missing_node_reference | cycle`

## 3. Status Constants
| Kind | Allowed Values |
|---|---|
| Workflow | `draft`, `published` |
| Run | `pending`, `running`, `waiting_approval`, `succeeded`, `failed`, `compensating`, `compensated`, `cancelled` |
| Terminal Run | `succeeded`, `failed`, `compensated`, `cancelled` |
| Step | `pending`, `running`, `waiting_approval`, `succeeded`, `failed`, `compensated`, `skipped` |
| Approval | `pending`, `approved`, `rejected` |
| Attempt | `running`, `succeeded`, `failed` (`kind`: `execute` \| `compensate`) |

## 4. Endpoints

### Workflows
| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/api/workflows/validate` | Public | `200 { valid: true, nodeCount, edgeCount, topologicalOrder }`, `400 invalid_request`, `422 invalid_workflow_graph` |
| `POST` | `/api/workflows` | Tenant | Create draft (0 nodes allowed) → `201 { workflow }` |
| `GET` | `/api/workflows` | Tenant | List tenant workflows → `200 { workflows }` |
| `GET` | `/api/workflows/:id` | Tenant | Get workflow draft → `200 { workflow }` or `404 workflow_not_found` |
| `PUT` | `/api/workflows/:id` | Tenant | Full draft replacement (schema-validated, last-write-wins) → `200 { workflow }` |
| `POST` | `/api/workflows/:id/publish` | Tenant | Validates draft (≥1 node, valid DAG), freezes immutable version → `201 { workflow, version }` or `422` |
| `GET` | `/api/workflows/:id/versions` | Tenant | List immutable version summaries → `200 { versions }` |
| `GET` | `/api/workflows/:id/export` | Tenant | Portable JSON export (`sagaflow/v1`) |
| `POST` | `/api/workflows/import` | Tenant | Import portable JSON as new draft → `201 { workflow }` |

### Runs & Live Resumable Streaming
| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/api/workflows/:id/runs` | Tenant | Requires `Idempotency-Key` header (`400` if missing). Persists run before enqueueing. `202 { run }` on creation, `200 { run }` on duplicate key, `409 workflow_not_published` if unpublished. |
| `GET` | `/api/runs` | Tenant | Filterable (`workflowId`, `status`, `limit`, `cursor`) newest-first → `200 { runs, nextCursor }` |
| `GET` | `/api/runs/:id` | Tenant | Run detail with ordered `steps[]`, all `execute`/`compensate` `attempts[]`, and persisted `events[]` → `200 { run, events }` |
| `GET` | `/api/runs/:id/stream` | Tenant | Resumable Server-Sent Events stream (`?since=<offset>` or `Last-Event-ID`). Replays missed persisted events then tails live updates until `run.completed`. |
| `POST` | `/api/runs/:id/cancel` | Tenant | Cooperative cancel: sets `cancelRequested: true`, signals active worker, returns `200 { run }` (or `409 run_not_cancellable` if terminal). |

### Dead-Letter Queue, Sandbox, Tenancy & Observability
| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/api/dlq` | Tenant | List captured failed/compensated runs → `200 { entries }` |
| `POST` | `/api/dlq/:id/replay` | Tenant | Start fresh idempotent retry run from DLQ entry → `202 { run, entry }` |
| `DELETE` | `/api/dlq/:id` | Tenant | Dismiss DLQ entry → `200 { deleted: true }` |
| `POST` | `/api/sandbox/test` | Tenant | Execute test JavaScript inside QuickJS-WASM sandbox → `200 { result }` |
| `GET` / `POST` | `/api/tenants` | Public/Dev | List tenants or provision a new isolated tenant database → `201 { tenant }` |
| `GET` / `POST` / `DELETE` | `/api/api-keys` | Tenant | Manage SHA-256 cryptographic API keys |
| `GET` / `POST` / `DELETE` | `/api/secrets` (`/:name`) | Tenant | Encrypted per-tenant secret vault (AES-256-GCM at rest; write-only API; automatic output/log redaction to `[REDACTED]`) |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/schedules` (`/:id`) | Tenant | Durable 5-field UTC cron schedules with minute-bucket idempotency |
| `POST` | `/api/schedules/:id/trigger` | Tenant | Immediately trigger a scheduled workflow → `202 { run, schedule }` |
| `POST` | `/api/hooks/:tenantSlug/:workflowId` | Public / HMAC | Public inbound webhook ingress with optional HMAC-SHA256 verification (`X-SagaFlow-Signature: sha256=<hex>`) & `Idempotency-Key` deduplication → `202` / `200` |
| `POST` | `/api/auth/register` & `/api/auth/login` | Public | Self-hosted `scrypt` password auth + HS256 JWT (Bearer token & `HttpOnly; SameSite=Lax` `sf_session` cookie) |
| `GET` / `POST` | `/api/auth/me` & `/api/auth/logout` | Session | Inspect authenticated user + tenant memberships or clear session cookie |
| `GET` | `/api/admin/metrics` | Tenant | Quotas, latency percentiles (`avg/p50/p95/p99`), step failure heatmap, storage info |
| `GET` | `/api/metrics` | Public | Native Prometheus / OpenMetrics exposition (`sagaflow_tenants_total`, `sagaflow_runs_total`, `sagaflow_dlq_open`, `sagaflow_approvals_pending`, `sagaflow_run_latency_ms`, RSS) |
| `POST` | `/api/admin/stress-test` | Tenant | Run concurrent pipelines (5–1,000 runs) and return throughput & latency metrics |
| `DELETE` | `/api/workflows/:id` | Tenant | Delete workflow definition and attached cron schedules |
| `GET` | `/api/approvals` | Tenant | List durable Human-in-the-Loop approval requests (`?status=pending\|approved\|rejected`) |
| `POST` | `/api/approvals/:id/decide` | Tenant | Approve (resumes downstream Saga from checkpoint) or Reject (triggers full reverse-order atomic DB rollback) |
| `POST` | `/api/callbacks/approval/:token` | Token | Public callback webhook allowing Slack/Email/PagerDuty systems to approve or reject a paused Saga gate |
| `GET` | `/api/state` | Tenant | Inspect live per-tenant transactional inventory, wallets/credits, KV store, immutable Saga Ledger, and Webhook Sink deliveries |
| `POST` | `/api/state/inventory` & `/api/state/balances` & `/api/state/kv` | Tenant | Restock inventory, top-up accounts, or upsert KV pairs directly inside the tenant DB |
| `ALL` | `/api/sink/:tenantSlug/:channel` | Public | Real persistent HTTP Webhook Sink recording headers, payload, method, and status for live HTTP workflow steps |
| `POST` | `/api/http/test` & `/api/webhooks/sign` | Tenant | Live server-side HTTP endpoint tester & real HMAC-SHA256 webhook signature generator |

### Step Template Variable Chaining
`http_request` (`url`, `headers`, `body`, `mockResponse`) and `custom_task` (`params`) support recursive template interpolation:
- `{{input.<path>}}` — access run trigger payload fields
- `{{steps.<nodeId>.<path>}}` — chain outputs from upstream DAG nodes (preserves native JSON types when a whole string is a single expression)
- `{{secrets.<NAME>}}` — decrypt tenant secrets at runtime; values are automatically scrubbed to `[REDACTED]` from all persisted step outputs, errors, and SSE events
- `{{env.tenantId}}` / `{{env.runId}}` / `{{env.attempt}}` — execution metadata
- `script` nodes receive `(input, steps, secrets)` where `secrets` contains **only** keys explicitly listed in `config.allowedSecrets` (least-privilege isolation).
