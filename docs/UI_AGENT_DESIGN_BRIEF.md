# SagaFlow — Complete Product & UI Design Specification (Master Brief for UI Agents)

> **Purpose:** Give any UI/UX design agent (Figma AI, v0, Lovable, Stitch, Cursor, Claude, etc.) **100% of the product context, component inventory, screen layouts, interactions, state machines, data structures, API bindings, design tokens, and UX improvement goals** so it can design an industry-leading UI that drops directly onto SagaFlow's real backend with zero mocks.

---

## 1. Product Identity & Core Value Proposition

**SagaFlow** is a **$0-budget, self-hostable, Multi-Tenant Distributed Workflow & Saga Orchestration Engine** with an embedded **AI Automation Agent**, **QuickJS-WASM Sandbox**, **Human-in-the-Loop (HITL) Approval Gates**, **AES-256-GCM Secret Vault**, **5-Field UTC Cron Scheduler**, and **Zero-Mock Real Persistent Transactional State**.

- **Target Persona:** Backend engineers, platform/SRE teams, fintech/e-commerce architects, and technical operators building fault-tolerant distributed workflows, AI pipelines, and human-reviewed financial automations.
- **Zero-Mock Rule (CRITICAL):** Every number, table row, inventory balance, wallet amount, webhook hit, AI response, and Saga rollback in the UI reflects **real database mutations** (SQLite DB-per-tenant, portable JSON folder, or Postgres RLS). Never design placeholder/fake metrics or decorative-only toggles — every button maps to a real API action.
- **Frontend Tech Stack (Strict Compatibility Target):**
  - **Framework:** React `19` + TypeScript (strict) + Vite `6`
  - **Styling:** Tailwind CSS `v4` (`@tailwindcss/vite`)
  - **Visual DAG Canvas:** `@xyflow/react` (`React Flow v12`)
  - **Icons:** `lucide-react`
  - **Backend API:** Hono REST API (`/api/*`) + Server-Sent Events (`SSE` offset-resumable durable event stream) + Prometheus OpenMetrics (`/api/metrics`)

---

## 2. Visual Direction & Color System (Carbon-Grey & Electric Neon Green)

- **Aesthetic Benchmark:** Linear × Vercel × Temporal × Razer Pro Hardware — industrial precision, ultra-crisp typography, disciplined negative space, dark carbon surfaces, and razor-sharp electric neon green accents used purposefully for primary CTAs, active navigation, healthy execution paths, and AI highlights.
- **Core Palette & CSS Variables (`apps/web/src/index.css`):**

| Token | Hex / Value | Usage |
| :--- | :--- | :--- |
| `--sf-bg` | `#0c0e10` | App shell & deepest canvas void |
| `--sf-rail` | `#111417` | Top command header, sidebars, inspector panels |
| `--sf-surface` | `#15191d` | Standard cards, inputs, panels |
| `--sf-elevated` | `#1c2126` | Hover cards, elevated chips, popovers |
| `--sf-border` | `#262c32` | Subtle hairline borders |
| `--sf-border-strong` | `#343d46` | Focused inputs, active card frames |
| `--sf-neon` | `#39ff14` | Primary electric neon green accent, active tab glow, primary CTA fill |
| `--sf-neon-soft` | `#22e55c` | Gradient partner for neon buttons & progress bars |
| `--sf-neon-dim` | `rgba(57, 255, 20, 0.12)` | Active tab pill tint, neon badge backgrounds |
| Primary CTA Text | `#070b07` (near-black bold) | **Mandatory contrast rule:** Always dark text on solid `#39ff14` buttons |
| Primary Body Text | `#e4e8ec` / `#ffffff` | Headings & high-priority labels |
| Muted / Meta Text | `#8b95a1` / `zinc-400` / `zinc-500` | Timestamps, IDs, captions |

- **Semantic Status Colors (Consistent Across Nodes, Badges, Waterfalls & Ledger):**
  - **Succeeded / Published / Healthy / AI Active:** Electric Neon Green (`#39ff14` / `#22e55c`)
  - **Waiting Approval / Warning / Pending Action:** Warm Amber (`#f59e0b` / `amber-400`)
  - **Running / Active Execution:** Pulsing Neon Green (`#39ff14`)
  - **Compensating / Compensated (Saga Rollback):** Electric Violet (`#a855f7` / `violet-400`)
  - **Failed / Rejected / DLQ / Destructive:** Crisp Crimson (`#f43f5e` / `rose-500`)
  - **Draft / Pending / Skipped / Neutral:** Carbon Zinc (`#71717a` / `zinc-500`)

- **Typography:**
  - UI Sans: `Inter`, system-ui (`-0.02em` tracking on headings)
  - Technical / Code / IDs / Timestamps / JSON / Cron / Metrics: Monospace (`JetBrains Mono` / `ui-monospace`) with `tabular-nums` on every counter, currency, and latency readout.

---

## 3. Global Application Shell (`apps/web/src/App.tsx`)

Full-viewport (`h-screen w-screen overflow-hidden`) IDE-grade workbench:

1. **Top Command Bar (`h-13`, fixed single-line — MUST never wrap or clip at `1280px–1920px`):**
   - **Left — Brand Lockup:** Glowing Neon Green `Layers` emblem + `SagaFlow` wordmark + live green pulse dot.
   - **Center — 9-Tab Segmented Navigation Pill:**
     1. `Studio` (`WorkflowIcon`) — Visual DAG Editor & Inspector
     2. `AI Agent` (`Bot`) — Autonomous Task Automation Agent (LM Studio + Google AI Studio)
     3. `Runs` (`Activity`) — Real-time Execution Monitor, Live DAG & SSE Stream
     4. `Approvals` (`UserCheck`) — **Amber counter badge** when pending approvals `> 0`
     5. `Ledger` (`Database`) — Zero-Mock Per-Tenant DB State, Inventory, Wallets, KV & Webhook Sink
     6. `Automation` (`Webhook`) — AES-256-GCM Secret Vault, HMAC Inbound Webhooks & 5-Field UTC Cron
     7. `DLQ` (`AlertTriangle`) — **Crimson counter badge** when open dead-letter failures `> 0`
     8. `Metrics` (`BarChart3`) — Latency Percentiles, High-Concurrency Load Lab & Prometheus Exporter
     9. `Settings` (`Sliders`) — Guide Mode Controls, Multi-Tenant Isolation, SHA-256 API Keys & Engine Health
   - **Right — Utility Cluster:**
     - **Quick Guide Toggle (`Guide ON` / `Guide`)** — Persisted in `localStorage` (`sagaflow_guide_mode`)
     - **Tenant Switcher Dropdown** — Switches active isolated DB (`Acme Commerce`, `Globex Logistics`, or user-provisioned tenants); refreshes all views cleanly
     - **Auth Button (`Sign In` or `<UserName> + Sign Out`)** — Opens `AuthModal` (scrypt + HS256 JWT)
2. **Contextual Guide Banner Slot (Conditional, directly below Top Command Bar):**
   - Shown when `guideMode === true` and not dismissed for the active tab.
   - Single sleek strip showing: `[GUIDE · <TAB>]` neon pill + concise headline/description + optional cross-tab CTA button (e.g., `Automate with AI Agent →`) + `7-Step Tour` launcher + `×` per-tab dismiss button.
3. **Main Workspace Viewport (`flex-1 min-h-0 overflow-hidden`):** Renders the active tab view.
4. **Global Overlays:**
   - **Toast Notification Stack** (bottom-right, auto-dismissing, tone-coded: `ok` neon green, `err` crimson, `info` carbon-zinc)
   - **Floating 7-Step Interactive Guide Tour Card** (`GuideTourCard`, bottom-right non-blocking card with progress bar, step indicators, `Back` / `Next` / `Finish` controls, and auto-navigation across tabs)
   - **Auth Modal** (`AuthModal`, centered glassmorphic dialog)

---

## 4. Complete Component Inventory (All 13 Components)

### Shared Primitives

#### 1. `StatusBadge.tsx`
- Pill badge with icon + uppercase mono label supporting ALL **Workflow Statuses** (`draft`, `published`), **Run Statuses** (`pending`, `running`, `waiting_approval`, `succeeded`, `failed`, `compensating`, `compensated`, `cancelled`), **Step Statuses** (`pending`, `running`, `waiting_approval`, `succeeded`, `failed`, `compensated`, `skipped`), and **Approval Statuses** (`pending`, `approved`, `rejected`).
- Animated spinner/pulse indicator for active `running`, `compensating`, and `waiting_approval` states.

#### 2. `SagaNode.tsx` (Custom React Flow v12 Node)
- Used in BOTH **Studio** (editable DAG designer) AND **Runs** (read-only live status overlay).
- **8 Distinct Step Kinds** — each needs an unmistakable icon, category eyebrow label, subtitle preview, and crisp handle layout:

| Step Kind (`type`) | Label | Purpose | Handles | Visual Cue |
| :--- | :--- | :--- | :--- | :--- |
| `trigger` | Trigger | Entrypoint (`manual`, `webhook`, `cron`) | Output right only | Neon Green Zap |
| `custom_task` | Saga Task | Real DB handler + optional compensator | Input left + Output right | Neon Green Gear + violet compensator pill (`↺ refund_payment`) |
| `script` | WASM | QuickJS-WASM isolated JS sandbox | Input left + Output right | Green/Cyan Code brackets + memory/timeout badge |
| `http_request` | Live HTTP | Real outbound HTTP call (`GET/POST/PUT/DELETE`) | Input left + Output right | Method + URL preview |
| `condition` | Condition | Boolean expression branch (`true` / `false`) | Input left + **2 labeled right handles (`true`, `false`)** | Violet GitBranch |
| `wait` | Wait | Durable non-blocking delay (`durationMs`) | Input left + Output right | Zinc Clock |
| `approval` | Approval Gate | Crash-resumable HITL gate (`approverRole`, `prompt`) | Input left + Output right | **Amber UserCheck** + amber accent border |
| `ai_agent` | AI Agent | Real LM Studio / Gemini LLM step (`provider`, `model`, `prompt`) | Input left + Output right | **Electric Neon Green Bot** + subtle neon glow |

- **Live Execution Overlay Additions (in `RunsView`):** Border shifts to step status color, displays status icon top-right, attempt count pill (`1 try` / `3 tries`), duration (`42ms`), and compensator badge if rolled back.

#### 3. `GuideOverlay.tsx`
- Exports `ContextualGuideBanner`, `GuideTourCard`, `TAB_GUIDES` (all 9 tabs), and `TOUR_STEPS` (7 guided steps):
  1. Visual DAG Studio (`studio`)
  2. Autonomous AI Agent (`ai`)
  3. Live Runs, Waterfall & SSE (`runs`)
  4. Durable Approval Gates (`approvals`)
  5. Zero-Mock State & Saga Ledger (`ledger`)
  6. Secrets Vault, Webhooks & Cron (`automation`)
  7. Metrics, Load Lab & Guide Controls (`observability`)

#### 4. `AuthModal.tsx`
- Tabbed modal (`Sign In` / `Create Account & Tenant`) for self-hosted `scrypt` + HS256 JWT authentication.
- Fields: Email, Password, Full Name (register), Workspace/Tenant Name (register).
- Includes 1-click "Fill Demo Admin Credentials" helper in `dev` mode.

---

### Full-Screen Views (All 9 Tabs)

#### 5. `WorkflowStudio.tsx` — Tab 1: **Studio** (3-Pane Visual DAG IDE)
- **Left Sidebar (`~250px`):**
  - Header `WORKFLOWS` + neon **`+ New`** button (opens **Blueprint Starter Modal**: Blank, Commerce Saga, Live HTTP Pipeline, Conditional Router).
  - Workflow list cards: Workflow name, `PUBLISHED` / `DRAFT` badge, workflow ID, active version (`v1`), click to load.
  - Seeded Acme workflows (5):
    1. `wf_ai_triage` — AI Order Risk Triage (LM Studio / Gemini → Condition → Approval Gate / Fast-Track Sink)
    2. `wf_human_approval` — Wire Transfer Approval Gate (Hold Funds → CFO Approval → Disburse)
    3. `wf_conditional_router` — High-Value Order Router
    4. `wf_saga_rollback` — Payment Decline Rollback Demo
    5. `wf_order_fulfillment` — Order Fulfillment Saga (Retry + Parallel Fan-Out)
  - Bottom keyboard shortcuts cheat-sheet (`⌘S` Save draft, `⌘↵` Run workflow, `Delete` remove selected node/edge).
- **Center Canvas:**
  - **Top Canvas Toolbar:** Inline editable workflow title input, version badge (`v1`), **Import JSON** button, **Export JSON** button, **Auto-Layout** button, **Version History** dropdown/switcher, **`AI Build`** shortcut button (jumps to AI Agent tab), **Save**, **Publish**, **Run** (neon primary CTA), and **Delete Workflow** trash button.
  - **Validation Alert Strip (conditional):** Displays live DAG validation errors (`cycle`, `missing_node_reference`, `duplicate_node_id`, etc.) from `POST /api/workflows/validate` with exact offending IDs.
  - **React Flow v12 Canvas:** Dot grid background, styled `Controls` (bottom-left), `MiniMap` (bottom-right), animated edges (with `true`/`false` labels on condition edges), drag-to-connect handles.
  - **Floating Bottom `ADD STEP` Dock:** Single-line horizontal pill bar with all **8 step types**: `Trigger`, `WASM`, `Saga Task`, `HTTP`, `Branch`, `Wait`, `Approval`, `AI Agent`.
- **Right Inspector Panel (`~320–360px`):**
  - **When NO node is selected (Workflow Inspector):** Editable workflow description + Quick Start tips card.
  - **When a Node IS selected (`INSPECTOR · <NODE_TYPE>`):**
    - Common controls: Step Label, read-only Step ID, Delete Node button.
    - **Type-specific editors:**
      - `trigger`: Trigger Type selector (`manual`, `webhook`, `cron`), webhook signature secret selector.
      - `custom_task`: Handler selector (all **9 real DB handlers**: `reserve_inventory`, `allocate_credits`, `charge_payment`, `create_shipment`, `send_notification`, `sync_customs`, `kv_set`, `audit_log`, `noop`) + auto-paired Compensation Handler + dynamic handler params (SKU, qty, amount, accountId, KV key/value, etc.).
      - `script`: Monospace JS code editor, timeout (`ms`), memory limit (`MB`), allowed secrets multi-select (least-privilege WASM injection), **`Test in WASM Sandbox`** live runner button with inline stdout/return/error preview!
      - `http_request`: HTTP method, URL (with quick-fill `/api/sink/<slug>/<channel>` helper), JSON Headers editor, JSON Body editor, timeout, **`Test Live HTTP Request`** button with live status code + response preview!
      - `condition`: JavaScript boolean expression editor (e.g. `steps.ai_triage?.riskLevel === 'high'`) with helper hints.
      - `wait`: Duration input (`ms`).
      - `approval`: Approver Role (e.g. `CFO / Finance Lead`), Approval Prompt template, Timeout (`ms`), Webhook notification URL (optional).
      - `ai_agent`: AI Provider override (`Tenant Default` / `LM Studio` / `Google AI Studio`), Model override, System Prompt textarea, Task Prompt textarea (supports `{{input.*}}` & `{{steps.*}}`), `Parse JSON output into step fields` toggle, and quick button **`Configure LM Studio / Gemini API Key →`**.
    - **Upstream Data Picker (Click-to-Copy Chips):** Dynamically scans upstream DAG nodes & secrets and displays clickable variable pills (`input.orderId`, `input.amount`, `steps.<id>.output`, `env.runId`, `secrets.<NAME>`) that copy `{{...}}` straight to clipboard or insert into focused fields.
    - **Collapsible Retry Policy & Chaos Fault Injection Drawer:** Max attempts, backoff (`ms`), multiplier, AND chaos testing toggles (`failOnAttempts` e.g. `[1]` to demo retries or `alwaysFail` to demo full Saga rollback).
- **Studio Modals (3):**
  1. **New Workflow Blueprint Modal** (4 starter cards)
  2. **Import Portable Workflow JSON Modal** (paste JSON or upload `.json` file)
  3. **Run Workflow Input Modal** (editable JSON payload, custom or auto-generated `Idempotency-Key`, and `Launch Run` button)

#### 6. `AiAgentView.tsx` — Tab 2: **AI Agent** (2-Column Provider Setup + Autonomous Chat Workbench)
- **Left Sidebar (`~340px`) — Real Model Provider Setup (`ZERO MOCKS`, `AES-256-GCM` badge):**
  - **2 Provider Cards (side-by-side):**
    - `LM Studio` (`LOCAL $0` — OpenAI-compatible local LLM)
    - `Google AI Studio` (`API KEY` — Gemini 2.5 Flash / Pro)
  - **Dynamic Provider Config Form:**
    - *If LM Studio:* Base URL input (`http://localhost:1234/v1`), Loaded Model ID input + **`Fetch Loaded Models`** live discovery button (renders clickable model chips when discovered), Optional Bearer Key input, LM Studio quick-setup hint box.
    - *If Google AI Studio:* Password-masked API Key input (shows `ENCRYPTED IN VAULT` pill + `Clear` button if saved; never reveals raw key), Gemini Model quick-pick chips (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-flash`) + custom model input, link hint to `aistudio.google.com/apikey`.
  - **Shared Controls:** Temperature slider (`0.0–1.0`), **`Save Config`** (neon primary CTA), **`Test Ping`** button + inline latency/model/error status box.
  - **Auto-Execute Tools Switch:** Toggle whether the agent autonomously executes real tools (`ON`) or returns dry-run plans only (`OFF`).
  - **1-Click Automation Starter Tasks (6 prompt chips):** Build & Publish Fraud Approval Saga, Audit Live State & Recent Runs, Build AI-Powered Order Triage DAG, Schedule Hourly Reconciliation, Restock Low Inventory SKU, Diagnose DLQ Failures.
- **Right Pane — Autonomous Task Automation Chat:**
  - Header showing active provider/model dot indicator + grounded data scope + `Clear Chat` button.
  - Scrollable conversation stream:
    - User messages (neon-tinted right bubble)
    - Assistant messages (carbon card with provider/model/latency/token-count footer)
    - **Executed Tool Action Cards** inline under each assistant message showing tool name (`create_workflow`, `run_workflow`, `decide_approval`, `create_schedule`, `adjust_inventory`, `adjust_balance`, `replay_dlq`), status badge (`succeeded`/`failed`/`planned`), summary, AND **direct deep-link action buttons** (`Open in Studio →`, `Inspect Live Run →`)!
  - Bottom prompt composer (`Enter` to send, `Shift+Enter` for newline, `Automate` neon button, footer listing all 7 live tools).

#### 7. `RunsView.tsx` — Tab 3: **Runs** (Execution Monitor + Live DAG / Waterfall + SSE Stream)
- **Left Sidebar (`~260px`) — Execution History:**
  - Status filter pills (`All`, `Running`, `Waiting_approval`, `Succeeded`, `Compensated`, `Failed`, `Cancelled`) + Refresh button.
  - Run cards showing workflow title, `StatusBadge`, truncated Run ID, duration (`ms`), timestamp.
- **Right Main Monitor:**
  - **Run Header Bar:** Workflow title, `StatusBadge`, version pill, **`Live SSE`** indicator badge, **View Mode Switcher (`Live DAG` ↔ `Waterfall`)**, **`Cancel`** button (for active runs), **`Re-run`** button.
  - **Waiting Approval Callout Banner (conditional when `waiting_approval`):** Amber banner explaining zero worker threads held + **`Open Approval Gate →`** button.
  - **Top Visualization Pane:**
    - *`Live DAG` mode:* Interactive React Flow v12 canvas showing color-coded real-time node statuses, animated active edges, click any node to scroll/expand its trace below! (Note: React Flow v12 requires `useNodesState` + `onNodesChange` even for read-only canvases.)
    - *`Waterfall` mode:* Timeline Gantt bar chart showing proportional step start offsets, execution bars (color-coded by succeeded/running/compensated/failed/skipped), and exact durations (`ms`).
  - **Bottom Split Panel (50/50):**
    - *Left — Step Traces & Atomic Rollbacks:* Accordion list of every step (`nodeId`, label, type, duration, `StatusBadge`). Expanding reveals every `attempt` (`execute` vs `compensate`), resolved input JSON, output JSON (with `[REDACTED]` secret scrubbing), console logs, and error stack/code.
    - *Right — Durable Event Stream (Offset-Resumable SSE):* Live terminal-style feed of sequence-numbered events (`#1 run.queued`, `#2 run.started`, `#3 step.started`, `#4 attempt.succeeded`, `#N step.compensated`, etc.) with timestamps and JSON payloads.

#### 8. `ApprovalsView.tsx` — Tab 4: **Approvals** (Durable Human-in-the-Loop Inbox)
- Header (`Durable Approval Gates`) + filter pills (`All`, `Pending (N)`, `Approved`, `Rejected`) + Refresh button.
- Approval Gate Cards:
  - Step title, `StatusBadge`, Approver Role pill (`CFO / Finance Lead`), Workflow name, clickable Run ID deep-link (`→ Runs`), timestamp, **`External Callback URL`** copy button (copies curl/webhook URL with single-use `callbackToken` for Slack/PagerDuty/email integrations!).
  - Highlighted approval prompt box (e.g. *"Approve wire transfer of $1250 for order WIRE-CFO-2026?"*).
  - Expandable **`Inspect Upstream Saga Payload & Checkpoint Context`** JSON viewer.
  - For pending gates: Decision comment input + **`Reject & Rollback Saga`** (crimson button triggering reverse-order DB rollback) + **`Approve & Resume`** (neon green primary CTA resuming downstream steps from checkpoint).
  - For decided gates: Displays decision banner (`Approved`/`Rejected`), reviewer name, comment, and timestamp.

#### 9. `LedgerView.tsx` — Tab 5: **Ledger** (Zero-Mock Per-Tenant DB State & Audit Proof)
- Top 4-tab sub-switcher (`Inventory & Wallets`, `Saga Ledger (N)`, `Webhook Sink (N)`, `KV Store (N)`) + Refresh button.
- **4 Live KPI Summary Cards:** Tracked SKUs, Ledger Commits (neon), Saga Rollbacks (violet), Real HTTP Sink Hits (neon).
- **Sub-tab 1 (`Inventory & Wallets`):**
  - *Left Card — Warehouse Inventory:* SKU cards with region tag, available/reserved counts, neon capacity bar + inline **`Restock / Adjust SKU`** form (`sku`, `label`, `delta`, `+ Apply`).
  - *Right Card — Accounts, Wallets & Credits:* Account rows (`customer_wallet`, `loyalty_credits`, `merchant_revenue`) with formatted currency/points + inline **`Top-Up / Adjust Account`** form (`accountId`, `currency`, `delta`, `+ Apply`).
- **Sub-tab 2 (`Saga Ledger`):** Immutable chronological table/feed of every forward commit and reverse rollback with Run ID deep-link, handler name, resource key, exact `before` vs `after` JSON state diff, and timestamp.
- **Sub-tab 3 (`Webhook Sink`):** Live inbox of real HTTP requests received by `/api/sink/:tenantSlug/:channel` (method, channel, status, headers, JSON body, timestamp) + `Clear Sink` button.
- **Sub-tab 4 (`KV Store`):** Durable key-value inspector with inline **`Set Key`** form (`key`, JSON `value`) and delete button per key (internal `__sagaflow_ai_config` hidden).

#### 10. `AutomationView.tsx` — Tab 6: **Automation** (Secrets Vault, Inbound Webhooks & UTC Cron)
- **Top 2-Column Grid:**
  - *Left Card — AES-256-GCM Secret Vault (`Write-Only · Auto-Redacted`):* Lists stored secret names (`•••••••`), description, updated time, delete button + inline **`Encrypt`** form (`NAME`, `Secret plaintext value`, `Description`). Note: Internal `__SAGAFLOW_AI_*` secrets are filtered out automatically.
  - *Right Card — Public Inbound Webhook & HMAC Signer:* Workflow selector, auto/custom Event ID (`New ID` button), editable JSON payload, signing secret dropdown, **`Compute HMAC-SHA256`** button (displays real computed `X-SagaFlow-Signature` header), **`Copy cURL`** button, and **`Fire Live Webhook`** button (returns live Run ID deep-link!).
- **Bottom Full-Width Card — Durable 5-Field UTC Cron Schedules:**
  - Quick cron presets (`Every 5m`, `Hourly`, `Daily 09:00 UTC`, `Mon–Fri 08:00`).
  - Form: Workflow selector, Schedule Name, 5-field UTC Cron expression, JSON Input, `Start enabled` checkbox, **`Add Schedule`** neon CTA.
  - **Live Cron Preview Bar:** Human-readable schedule explanation + next 3 exact UTC fire timestamps computed live!
  - Existing Schedules List: Schedule name, cron pill, `Active`/`Paused` badge, workflow name, next UTC run time, **`Enable`/`Pause`** toggle, **`Run Now`** instant trigger button, and delete button.

#### 11. `DlqView.tsx` — Tab 7: **DLQ** (Dead-Letter Queue & Replay)
- Header showing open failure count + Refresh button.
- Empty state (neon checkmark: *"Dead-Letter Queue is empty — all runs healthy."*).
- DLQ Failure Cards: Workflow name, failed Run ID, failed Step ID, error code & message, compensation summary (`compensated` vs `failed`), timestamp, **`Replay Run`** neon action button (re-enqueues fresh run and deep-links to `Runs`), and **`Dismiss / Delete`** button.

#### 12. `ObservabilityView.tsx` — Tab 8: **Metrics** (Telemetry, High-Concurrency Load Lab & Prometheus)
- **5 Live KPI Cards:** Total Runs (with active & open DLQ count), Succeeded (with `%`), Compensated (atomic rollbacks), Failed (with cancelled count), `p95 Latency` (with `p50` & `p99`).
- **2-Column Charts:**
  - *Left — Latency Distribution (`ms`):* Horizontal neon/amber/crimson progress bars for `Average`, `p50 Median`, `p95 Tail`, `p99 Max`.
  - *Right — Recent Run Throughput:* Stacked vertical bar chart by minute bucket (`OK` neon green, `Rollback` violet, `Failed` crimson).
- **Real High-Concurrency Load Lab Card:**
  - Quick preset buttons (`25 runs`, `100 runs`, `250 runs`, `500 runs`), Published Workflow selector (defaults to `Order Fulfillment Saga`), Concurrent Runs input (`1–1000`), **`Launch N Runs`** CTA.
  - Live result summary card showing succeeded/failed counts, throughput (`runs/sec`), enqueue time, total wall time, and min/avg/p50/p95/p99/max latency!
- **Prometheus / OpenMetrics Exporter Card:**
  - **`Inspect /api/metrics`** button toggles an inline syntax-clean raw OpenMetrics text viewer (`sagaflow_tenants_total`, `sagaflow_runs_total`, `sagaflow_approvals_pending`, etc.) with Copy button.

#### 13. `SettingsView.tsx` — Tab 9: **Settings** (Guide Mode, Multi-Tenancy, API Keys & Engine Health)
- **Hero Neon Card — Interactive Guide Mode:**
  - Master toggle switch (`GUIDE ON` / `GUIDE OFF`, persisted in `localStorage`).
  - 3 Quick-Action Sub-Cards:
    1. **7-Step Interactive Tour** → `Launch Interactive Tour` neon CTA
    2. **Contextual Tab Banners** → `Restore All Tab Tips` button
    3. **AI Automation Agent Status** → Shows active provider & model (`LM Studio (local)` or `Google AI Studio (gemini-2.5-flash)`) + `Configure LM Studio / Gemini →` button
- **Multi-Tenant Workspaces Card (Physical DB-per-Tenant Isolation):**
  - Clickable Tenant cards showing Name, `ACTIVE` neon badge, Tenant ID, quota (`200 runs · 600 req/min`), and active storage isolation mode.
  - Inline **`+ Provision Tenant DB`** form (`New Tenant Name`, `Slug`).
- **Cryptographic API Keys Card (SHA-256 Hashed at Rest):**
  - Inline **`Generate Key`** form (displays raw key ONCE in a high-visibility copyable callout banner with security warning).
  - Active Keys list with prefix (`sf_live_...`), created date, **`Use in Session`** test button, and **`Revoke`** button.
- **Engine & Storage Runtime Card:** Live readout from `GET /api/health` (`driver`, `isolation`, `location`, `queueDriver`, `workerConcurrency`, `encryption: AES-256-GCM`, `role`, `authMode`, `scheduler status`).

---

## 5. Complete Backend API Surface (`apps/web/src/lib/api.ts`)

All tenant-scoped requests send `X-Tenant-Id` + either `Authorization: Bearer <jwt>`, `X-API-Key: <key>`, or `X-User-Id: usr_demo_admin` (in `dev` mode):

| Domain | Endpoints |
| :--- | :--- |
| **System & Tenants** | `GET /api/health`, `GET /api/tenants`, `POST /api/tenants`, `GET /api/metrics` (Prometheus) |
| **Auth (scrypt + HS256)** | `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/logout` |
| **Workflows & DAG** | `POST /api/workflows/validate`, `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id`, `POST /api/workflows/:id/publish`, `GET /api/workflows/:id/versions`, `GET /api/workflows/:id/export`, `POST /api/workflows/import` |
| **Runs & Real-Time SSE** | `POST /api/workflows/:id/runs` (requires `Idempotency-Key`), `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/stream` (SSE with `Last-Event-ID`) |
| **AI Automation Agent** | `GET/PUT /api/ai/config`, `POST /api/ai/test`, `POST /api/ai/lmstudio/models`, `POST /api/ai/agent/chat` |
| **Approvals (HITL)** | `GET /api/approvals`, `POST /api/approvals/:id/decision`, `POST /api/callbacks/approval/:token` (public) |
| **Zero-Mock State & Sink** | `GET /api/state`, `POST /api/state/inventory`, `POST /api/state/balances`, `PUT/DELETE /api/state/kv/:key`, `DELETE /api/state/sink`, `ALL /api/sink/:slug/:channel` |
| **Automation & Vault** | `GET/POST/DELETE /api/secrets`, `GET/POST/PATCH/DELETE /api/schedules`, `POST /api/schedules/:id/trigger`, `POST /api/webhooks/:slug/:wfId`, `POST /api/webhooks/sign`, `POST /api/http/test`, `POST /api/sandbox/test` |
| **DLQ, Keys & Load Lab** | `GET /api/dlq`, `POST /api/dlq/:id/replay`, `DELETE /api/dlq/:id`, `GET/POST/DELETE /api/api-keys`, `GET /api/admin/metrics`, `POST /api/admin/stress-test` |

---

## 6. Design Opportunities & Upgrade Wishlist for Your UI Agent

If your UI agent is redesigning or elevating SagaFlow's UI, here are the highest-leverage improvements to prioritize while keeping **100% of existing features & zero mocks intact**:

1. **Command Palette (`⌘K`)**: Global quick-switcher to jump across workflows, runs, approvals, tenants, tabs, and 1-click AI agent tasks from anywhere.
2. **Studio Canvas Polish**:
   - Collapsible Left Workflow Rail & Right Inspector Drawer so complex 20+ node DAGs get maximum canvas space.
   - Inline node search & zoom-to-fit shortcuts, plus richer visual node cards (subtle status micro-sparklines, inline preview of condition expressions & AI model badges).
   - Edge inspector when clicking an edge (toggle `true`/`false` condition branch or delete edge visually).
3. **AI Agent Experience Elevation**:
   - Structured markdown rendering (code blocks with copy button, bold, inline code, bullet lists) inside assistant messages.
   - Visual "Execution Plan Diff / DAG Preview" inside `create_workflow` tool cards showing node count + step icons before clicking `Open in Studio →`.
   - Collapsible provider config drawer once connected so the chat workspace can expand to full width.
4. **Live Runs & Waterfall**:
   - Split-pane resizable divider between the Live DAG/Waterfall top half and Step Traces / SSE Event Stream bottom half.
   - Side-by-side JSON Diff viewer for Saga `execute` vs `compensate` attempts.
5. **Responsive / Smaller Viewport Polish (`1024px–1280px`)**:
   - Compact icon+tooltip mode for top nav tabs or collapsible vertical left icon rail (Linear/VS Code style) so `Studio` and `AI Agent` stay effortless even on 13" laptops.
6. **Micro-Interactions & Motion**:
   - Subtle electric-green pulse along active DAG edges during execution, smooth spring transitions on modal/drawer opens, skeleton loaders on initial fetch, and crisp focus rings (`#39ff14`) for full keyboard accessibility.
7. **Hard Technical Constraints (Do Not Break):**
   - Keep `@xyflow/react` v12 controlled nodes paired with `useNodesState` + `onNodesChange` (otherwise nodes stay `visibility: hidden`).
   - Keep `loadConfig` effects scoped strictly to `session.tenantId` so typing API keys or editing drafts is never reset by background polling.
   - Never expose raw API keys or secrets in DOM/logs; always respect `AES-256-GCM` write-only secret patterns.
   - Keep dark text (`#070b07`) on solid `#39ff14` neon green buttons for WCAG AAA readability.
