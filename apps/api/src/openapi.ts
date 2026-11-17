export function buildOpenApiSpec(serverUrl = '') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SagaFlow Distributed Workflow & Saga Engine API',
      version: '8.0.0',
      description:
        'Multi-tenant durable DAG orchestration API with Projects Workspace Hub (empty & template-seeded isolated DBs), 16 real node types (Transform, Filter, Switch, Email, Slack/Discord/Teams, Transactional Database/KV, QuickJS-WASM, HTTP, Saga Tasks, Nested Sub-Workflows, Dynamic for_each, Approval SLA Gates, AI Agents), Time-Travel Step Resume, Zero-Mutation Dry-Run, AES-256-GCM Secret Vault, RBAC, and Signed Compliance Audits.',
    },
    servers: [{ url: serverUrl || '/', description: 'Active SagaFlow Instance' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        BearerJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        DevTenantHeader: { type: 'apiKey', in: 'header', name: 'X-Tenant-Id' },
      },
    },
    security: [{ ApiKeyAuth: [] }, { BearerJwt: [] }],
    paths: {
      '/api/health': {
        get: {
          tags: ['Platform'],
          summary: 'Cluster health, storage driver, queue status & handlers',
          responses: { '200': { description: 'Healthy cluster status' } },
        },
      },
      '/api/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List isolated project workspaces with workflow, run, approval & DLQ counts',
          responses: { '200': { description: 'Project summaries list' } },
        },
        post: {
          tags: ['Projects'],
          summary: 'Create an empty or template-seeded isolated project workspace',
          responses: { '201': { description: 'Created project & optional starter workflows' } },
        },
      },
      '/api/workflows': {
        get: {
          tags: ['Workflows'],
          summary: 'List tenant workflows',
          responses: { '200': { description: 'Tenant workflows list' } },
        },
        post: {
          tags: ['Workflows'],
          summary: 'Create workflow draft (Admin / Operator)',
          responses: { '201': { description: 'Workflow draft created' } },
        },
      },
      '/api/workflows/{workflowId}/publish': {
        post: {
          tags: ['Workflows'],
          summary: 'Validate DAG & publish immutable version (Admin / Operator)',
          responses: { '200': { description: 'Published immutable version' } },
        },
      },
      '/api/workflows/{workflowId}/diff': {
        get: {
          tags: ['Workflows'],
          summary: 'Compute structural DAG diff between two versions or draft (?from=1&to=draft)',
          responses: { '200': { description: 'Added/removed/modified nodes & edges' } },
        },
      },
      '/api/workflows/{workflowId}/versions/{versionNumber}/restore': {
        post: {
          tags: ['Workflows'],
          summary: 'Restore historical published version into editable draft (Admin / Operator)',
          responses: { '200': { description: 'Draft restored from historical version' } },
        },
      },
      '/api/workflows/{workflowId}/dry-run': {
        post: {
          tags: ['Workflows'],
          summary: 'Zero-mutation step-by-step dry-run with live WASM & template resolution',
          responses: { '200': { description: 'Step-by-step dry-run trace & bindings' } },
        },
      },
      '/api/workflows/{workflowId}/runs': {
        post: {
          tags: ['Runs'],
          summary: 'Start idempotent Saga run (requires Idempotency-Key header)',
          responses: {
            '202': { description: 'Run queued' },
            '200': { description: 'Existing idempotent run returned' },
          },
        },
      },
      '/api/runs/{runId}/resume-from/{nodeId}': {
        post: {
          tags: ['Runs'],
          summary: 'Time-travel checkpoint replay from failed/target step with optional payload patch',
          responses: { '202': { description: 'Forked run queued from target node' } },
        },
      },
      '/api/alerts': {
        get: {
          tags: ['Alerts'],
          summary: 'List tenant HMAC-signed webhook alert rules',
          responses: { '200': { description: 'Alert rules list' } },
        },
        post: {
          tags: ['Alerts'],
          summary: 'Create webhook alert rule for run failures, DLQ, or SLA breaches',
          responses: { '201': { description: 'Alert rule created' } },
        },
      },
      '/api/alerts/{ruleId}/test': {
        post: {
          tags: ['Alerts'],
          summary: 'Send live signed test webhook delivery for an alert rule',
          responses: { '200': { description: 'Delivery status & HMAC signature header' } },
        },
      },
      '/api/runs/{runId}/stream': {
        get: {
          tags: ['Runs'],
          summary: 'Resumable Durable SSE event stream (Last-Event-ID offset)',
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/api/ai/diagnose-run/{runId}': {
        post: {
          tags: ['AI Agent'],
          summary: 'AI / Deterministic root-cause forensics & Saga rollback verification',
          responses: { '200': { description: 'Structured diagnosis & recommendations' } },
        },
      },
      '/api/ai/agent/chat': {
        post: {
          tags: ['AI Agent'],
          summary: 'Autonomous multi-tool AI agent chat (LM Studio / Google Gemini)',
          responses: { '200': { description: 'Agent reply & executed tool traces' } },
        },
      },
      '/api/approvals': {
        get: {
          tags: ['Approvals'],
          summary: 'List durable HITL approval gates',
          responses: { '200': { description: 'Approval gates list' } },
        },
      },
      '/api/approvals/{approvalId}/decision': {
        post: {
          tags: ['Approvals'],
          summary: 'Approve (resume) or Reject (rollback) a parked Saga (Admin / Approver)',
          responses: { '200': { description: 'Approval decided & Saga resumed' } },
        },
      },
      '/api/state': {
        get: {
          tags: ['State & Ledger'],
          summary: 'Inspect real tenant inventory, balances, KV, Saga ledger & webhook sink',
          responses: { '200': { description: 'Real tenant state snapshot' } },
        },
      },
      '/api/rbac/members': {
        get: {
          tags: ['Security & RBAC'],
          summary: 'List tenant members & active RBAC role',
          responses: { '200': { description: 'Tenant members list' } },
        },
        post: {
          tags: ['Security & RBAC'],
          summary: 'Assign tenant RBAC role (admin | operator | approver | viewer) — Admin only',
          responses: { '200': { description: 'Role updated' } },
        },
      },
      '/api/audit/export': {
        get: {
          tags: ['Security & RBAC'],
          summary: 'Export HMAC-SHA256 cryptographically signed Compliance Audit Bundle',
          responses: { '200': { description: 'Signed JSON audit bundle' } },
        },
      },
      '/api/audit/verify': {
        post: {
          tags: ['Security & RBAC'],
          summary: 'Verify HMAC-SHA256 signature integrity of a Compliance Audit Bundle',
          responses: { '200': { description: 'Verification status' } },
        },
      },
      '/api/metrics': {
        get: {
          tags: ['Observability'],
          summary: 'Prometheus / OpenMetrics scrape endpoint',
          responses: { '200': { description: 'text/plain OpenMetrics payload' } },
        },
      },
    },
  };
}

export function renderApiDocsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SagaFlow v6 — OpenAPI 3.1 Interactive Explorer</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #0c0e10; color: #f1f5f9; font-family: Inter, system-ui, sans-serif; line-height: 1.5; }
    code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace; }
    header { background: #111417; border-bottom: 1px solid #262c32; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
    .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(34,229,92,0.35); background: rgba(34,229,92,0.10); color: #22e55c; }
    main { max-width: 1080px; margin: 0 auto; padding: 24px; }
    .bar { background: #15191d; border: 1px solid #262c32; border-radius: 4px; padding: 14px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 20px; }
    input { background: #111417; border: 1px solid #262c32; border-radius: 4px; color: #f1f5f9; padding: 7px 10px; font-size: 12px; font-family: "JetBrains Mono", monospace; }
    input:focus { outline: none; border-color: #22e55c; }
    button { background: #22e55c; color: #070b07; border: none; border-radius: 4px; padding: 7px 12px; font-size: 11px; font-weight: 700; cursor: pointer; font-family: "JetBrains Mono", monospace; text-transform: uppercase; }
    button:hover { background: #39ff14; }
    button.sec { background: #15191d; color: #f1f5f9; border: 1px solid #262c32; }
    button.sec:hover { background: #1c2227; border-color: #2f373f; }
    .ep { background: #15191d; border: 1px solid #262c32; border-radius: 4px; margin-bottom: 10px; overflow: hidden; }
    .ep-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; gap: 12px; flex-wrap: wrap; }
    .method { font-size: 10px; font-weight: 700; padding: 3px 7px; border-radius: 4px; min-width: 52px; text-align: center; }
    .GET { background: rgba(34,229,92,0.12); color: #22e55c; border: 1px solid rgba(34,229,92,0.3); }
    .POST { background: rgba(245,158,11,0.12); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3); }
    .path { font-size: 13px; font-weight: 600; color: #f1f5f9; }
    .desc { font-size: 12px; color: #808d99; }
    pre.out { margin: 0; background: #111417; border-top: 1px solid #262c32; padding: 12px 14px; font-size: 11px; color: #73ff86; max-height: 280px; overflow: auto; display: none; }
    a { color: #22e55c; text-decoration: none; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span>SagaFlow OpenAPI 3.1 Explorer</span><span class="badge mono">v6.0.0</span></div>
    <div style="display:flex;gap:14px;align-items:center">
      <a class="mono" href="/api/openapi.json" target="_blank">/api/openapi.json</a>
      <a class="mono" href="/">← Back to Studio</a>
    </div>
  </header>
  <main>
    <div class="bar">
      <span class="mono" style="font-size:11px;color:#808d99">AUTH HEADERS:</span>
      <input id="tenant" value="ten_acme" placeholder="X-Tenant-Id" />
      <input id="user" value="usr_demo_admin" placeholder="X-User-Id" />
      <input id="apikey" value="" placeholder="Optional X-Api-Key (sf_...)" style="min-width:220px" />
    </div>
    <div id="list" class="mono" style="font-size:12px;color:#808d99">Loading OpenAPI 3.1 specification...</div>
  </main>
  <script>
    fetch('/api/openapi.json').then(r => r.json()).then(spec => {
      const root = document.getElementById('list');
      root.innerHTML = '';
      Object.entries(spec.paths).forEach(([p, methods]) => {
        Object.entries(methods).forEach(([m, op]) => {
          const M = m.toUpperCase();
          const card = document.createElement('div');
          card.className = 'ep';
          const canTry = M === 'GET' && !p.includes('{');
          card.innerHTML = \`
            <div class="ep-head">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span class="method mono \${M}">\${M}</span>
                <span class="path mono">\${p}</span>
                <span class="desc">\${op.summary || ''}</span>
              </div>
              \${canTry ? '<button class="sec try-btn">Try Live</button>' : '<span class="mono" style="font-size:10px;color:#808d99">PARAM / MUTATION</span>'}
            </div>
            <pre class="out"></pre>
          \`;
          if (canTry) {
            card.querySelector('.try-btn').onclick = async () => {
              const out = card.querySelector('.out');
              out.style.display = 'block';
              out.textContent = 'Fetching ' + p + '...';
              const h = {};
              const key = document.getElementById('apikey').value.trim();
              if (key) h['X-Api-Key'] = key;
              else {
                h['X-Tenant-Id'] = document.getElementById('tenant').value.trim();
                h['X-User-Id'] = document.getElementById('user').value.trim();
              }
              const res = await fetch(p, { headers: h });
              const txt = await res.text();
              try { out.textContent = res.status + ' ' + res.statusText + '\\n' + JSON.stringify(JSON.parse(txt), null, 2); }
              catch { out.textContent = res.status + ' ' + res.statusText + '\\n' + txt; }
            };
          }
          root.appendChild(card);
        });
      });
    });
  </script>
</body>
</html>`;
}
