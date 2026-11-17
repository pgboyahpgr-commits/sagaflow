import type { DraftWorkflowInput } from '@sagaflow/shared';

export type BlueprintCategory =
  | 'Sales & CRM'
  | 'AI Ops'
  | 'DevOps'
  | 'Commerce'
  | 'Finance'
  | 'Analytics'
  | 'Platform'
  | 'Batch'
  | 'Compliance';

export interface WorkflowBlueprint {
  id: string;
  name: string;
  category: BlueprintCategory;
  popular?: boolean;
  summary: string;
  highlights: string[];
  sampleInput: Record<string, unknown>;
  definition: DraftWorkflowInput;
}

export const WORKFLOW_BLUEPRINTS: WorkflowBlueprint[] = [
  {
    id: 'bp_lead_capture_crm',
    name: 'Lead Capture → CRM + Slack & Welcome Email',
    category: 'Sales & CRM',
    popular: true,
    summary:
      'Normalizes inbound signup leads, filters out invalid emails, saves the lead to your database (with atomic rollback), then notifies Slack and sends a welcome email in parallel.',
    highlights: ['Transform Mapper', 'Email Filter Guard', 'Database Save', 'Slack + Email'],
    sampleInput: {
      leadId: 'lead_9012',
      firstName: 'Maya',
      lastName: 'Lin',
      email: 'maya@northstar.io',
      company: 'Northstar Labs',
      source: 'pricing-page',
    },
    definition: {
      name: 'Lead Capture → CRM + Slack & Welcome Email',
      description:
        'Normalizes inbound form leads, validates business email, persists to tenant database, and sends parallel Slack + welcome email alerts.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Website Lead Webhook',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'normalize_lead',
          type: 'transform',
          label: 'Normalize Lead Fields',
          position: { x: 330, y: 170 },
          config: {
            mergeWithInput: true,
            mappings: {
              fullName: '{{input.firstName}} {{input.lastName}}',
              leadKey: '{{input.leadId}}',
              stage: 'qualified',
            },
          },
        },
        {
          id: 'valid_email',
          type: 'filter',
          label: 'Valid Email Guard',
          position: { x: 620, y: 170 },
          config: {
            field: '{{input.email}}',
            operator: 'contains',
            value: '@',
            onFail: 'skip_downstream',
          },
        },
        {
          id: 'save_lead',
          type: 'database',
          label: 'Save Lead in Database',
          position: { x: 910, y: 170 },
          config: {
            operation: 'set',
            collection: 'crm_leads',
            key: '{{input.leadId}}',
            value: {
              fullName: '{{steps.normalize_lead.output.fullName}}',
              email: '{{input.email}}',
              company: '{{input.company}}',
              stage: 'qualified',
            },
          },
        },
        {
          id: 'notify_slack',
          type: 'slack_discord',
          label: 'Post to #sales-leads',
          position: { x: 1210, y: 70 },
          config: {
            platform: 'slack',
            channelName: '#sales-leads',
            severity: 'success',
            title: 'New Qualified Lead: {{input.company}}',
            message: '{{steps.normalize_lead.output.fullName}} ({{input.email}}) signed up via {{input.source}}.',
          },
        },
        {
          id: 'welcome_email',
          type: 'email',
          label: 'Send Welcome Email',
          position: { x: 1210, y: 270 },
          config: {
            provider: 'sink',
            to: '{{input.email}}',
            subject: 'Welcome to SagaFlow, {{input.firstName}}!',
            body: 'Hi {{input.firstName}}, thanks for connecting from {{input.company}}. Your workspace is ready.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'normalize_lead', condition: 'always' },
        { id: 'e2', from: 'normalize_lead', to: 'valid_email', condition: 'always' },
        { id: 'e3', from: 'valid_email', to: 'save_lead', condition: 'always' },
        { id: 'e4', from: 'save_lead', to: 'notify_slack', condition: 'always' },
        { id: 'e5', from: 'save_lead', to: 'welcome_email', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_support_switch_router',
    name: 'Support Ticket Multi-Way Router & Escalation',
    category: 'AI Ops',
    popular: true,
    summary:
      'Routes incoming support tickets across Urgent, Billing, and General paths using a Multi-Way Switch — paging Slack for incidents, opening an approval gate for refunds, and emailing confirmations.',
    highlights: ['Multi-Way Switch', 'Slack Pager', 'HITL Escalation', 'Auto-Reply Email'],
    sampleInput: {
      ticketId: 'TKT-4421',
      customerEmail: 'alex@cloudcorp.io',
      category: 'urgent',
      subject: 'Production webhook latency spike',
      refundAmount: 0,
    },
    definition: {
      name: 'Support Ticket Multi-Way Router & Escalation',
      description:
        'Classifies and routes inbound tickets to Urgent on-call Slack, Billing approval review, or automated self-service email.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Inbound Support Ticket',
          position: { x: 40, y: 200 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'save_ticket',
          type: 'database',
          label: 'Log Ticket in DB',
          position: { x: 330, y: 200 },
          config: {
            operation: 'set',
            collection: 'support_tickets',
            key: '{{input.ticketId}}',
            value: {
              email: '{{input.customerEmail}}',
              category: '{{input.category}}',
              subject: '{{input.subject}}',
            },
          },
        },
        {
          id: 'route_ticket',
          type: 'switch',
          label: 'Route by Ticket Category',
          position: { x: 630, y: 200 },
          config: {
            expression: '{{input.category}}',
            defaultCase: 'general',
            cases: [
              { key: 'urgent', label: 'Urgent Incident', operator: 'eq', value: 'urgent' },
              { key: 'billing', label: 'Billing & Refunds', operator: 'eq', value: 'billing' },
            ],
          },
        },
        {
          id: 'page_oncall',
          type: 'slack_discord',
          label: 'Page #oncall-incidents',
          position: { x: 960, y: 40 },
          config: {
            platform: 'slack',
            channelName: '#oncall-incidents',
            severity: 'critical',
            title: 'URGENT Ticket {{input.ticketId}}',
            message: '{{input.subject}} — reported by {{input.customerEmail}}',
          },
        },
        {
          id: 'billing_review',
          type: 'approval',
          label: 'Billing Lead Sign-Off',
          position: { x: 960, y: 200 },
          config: {
            approverRole: 'Billing Lead',
            prompt: 'Approve billing request for {{input.ticketId}} ({{input.customerEmail}})?',
            slaMinutes: 60,
            onTimeout: 'escalate',
          },
        },
        {
          id: 'auto_reply',
          type: 'email',
          label: 'Send Ticket Confirmation',
          position: { x: 960, y: 360 },
          config: {
            provider: 'sink',
            to: '{{input.customerEmail}}',
            subject: 'We received your request [{{input.ticketId}}]',
            body: 'Hi! Our team has logged "{{input.subject}}" and will follow up shortly.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'save_ticket', condition: 'always' },
        { id: 'e2', from: 'save_ticket', to: 'route_ticket', condition: 'always' },
        { id: 'e3', from: 'route_ticket', to: 'page_oncall', condition: 'urgent', label: 'urgent' },
        { id: 'e4', from: 'route_ticket', to: 'billing_review', condition: 'billing', label: 'billing' },
        { id: 'e5', from: 'route_ticket', to: 'auto_reply', condition: 'general', label: 'general' },
      ],
    },
  },
  {
    id: 'bp_uptime_incident_monitor',
    name: 'API Uptime Monitor & Incident Pager',
    category: 'DevOps',
    popular: true,
    summary:
      'Probes a service endpoint, evaluates response status in QuickJS-WASM, filters degraded health, logs an incident counter in your database, and alerts Discord/Slack + Ops Email.',
    highlights: ['Live HTTP Probe', 'Filter Guard', 'DB Incident Counter', 'Discord + Email'],
    sampleInput: {
      serviceName: 'checkout-api',
      endpointUrl: '/api/sink/acme-commerce/health-probe',
      onCallEmail: 'sre@acme.local',
      forceDegraded: true,
    },
    definition: {
      name: 'API Uptime Monitor & Incident Pager',
      description:
        'Scheduled/manual service health monitor that logs outages and alerts on-call SRE channels.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Cron / Manual Check',
          position: { x: 40, y: 170 },
          config: { triggerType: 'cron' },
        },
        {
          id: 'probe',
          type: 'http_request',
          label: 'Probe Service Endpoint',
          position: { x: 330, y: 170 },
          config: {
            method: 'POST',
            url: '{{input.endpointUrl}}',
            body: { ping: true, service: '{{input.serviceName}}' },
          },
        },
        {
          id: 'evaluate',
          type: 'script',
          label: 'Evaluate Health SLA (WASM)',
          position: { x: 620, y: 170 },
          config: {
            code: 'const status = steps.probe?.status ?? 500; const healthy = !input.forceDegraded && status >= 200 && status < 300; return { service: input.serviceName, status, healthy, severity: healthy ? "ok" : "critical" };',
          },
        },
        {
          id: 'only_if_down',
          type: 'filter',
          label: 'Trigger Only When Degraded',
          position: { x: 910, y: 170 },
          config: {
            field: '{{steps.evaluate.output.healthy}}',
            operator: 'eq',
            value: 'false',
            onFail: 'skip_downstream',
          },
        },
        {
          id: 'inc_counter',
          type: 'database',
          label: 'Increment Incident Counter',
          position: { x: 1200, y: 70 },
          config: {
            operation: 'increment',
            collection: 'incidents',
            key: '{{input.serviceName}}',
            delta: 1,
          },
        },
        {
          id: 'discord_alert',
          type: 'slack_discord',
          label: 'Alert Discord #sre-ops',
          position: { x: 1200, y: 270 },
          config: {
            platform: 'discord',
            channelName: '#sre-ops',
            severity: 'critical',
            title: 'Service Degraded: {{input.serviceName}}',
            message: 'Health check reported status {{steps.evaluate.output.status}} on {{input.endpointUrl}}.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'probe', condition: 'always' },
        { id: 'e2', from: 'probe', to: 'evaluate', condition: 'always' },
        { id: 'e3', from: 'evaluate', to: 'only_if_down', condition: 'always' },
        { id: 'e4', from: 'only_if_down', to: 'inc_counter', condition: 'always' },
        { id: 'e5', from: 'only_if_down', to: 'discord_alert', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_daily_kpi_digest',
    name: 'Daily KPI Digest & Scheduled Slack Report',
    category: 'Analytics',
    popular: true,
    summary:
      'Reads live stored records from your tenant database, calculates daily KPI metrics inside QuickJS-WASM, formats a clean executive summary, and posts to Slack + leadership email.',
    highlights: ['Database List', 'QuickJS-WASM Math', 'Transform Summary', 'Slack + Email Digest'],
    sampleInput: {
      reportDate: '2026-11-17',
      revenueToday: 14850,
      newSignups: 42,
      execEmail: 'founders@acme.local',
    },
    definition: {
      name: 'Daily KPI Digest & Scheduled Slack Report',
      description:
        'Aggregates business metrics into a crisp executive report delivered to Slack and email.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Daily 09:00 UTC Trigger',
          position: { x: 40, y: 170 },
          config: { triggerType: 'cron' },
        },
        {
          id: 'list_leads',
          type: 'database',
          label: 'Read Stored CRM Leads',
          position: { x: 330, y: 170 },
          config: {
            operation: 'list',
            collection: 'crm_leads',
          },
        },
        {
          id: 'calc_kpi',
          type: 'script',
          label: 'Compute KPI Snapshot (WASM)',
          position: { x: 630, y: 170 },
          config: {
            code: 'const rev = Number(input.revenueToday ?? 0); const signups = Number(input.newSignups ?? 0); const storedLeads = Number(steps.list_leads?.count ?? 0); const arpu = signups > 0 ? Math.round((rev / signups) * 100) / 100 : 0; return { reportDate: input.reportDate, revenueToday: rev, newSignups: signups, storedLeads, arpu };',
          },
        },
        {
          id: 'slack_digest',
          type: 'slack_discord',
          label: 'Post to #daily-metrics',
          position: { x: 940, y: 75 },
          config: {
            platform: 'slack',
            channelName: '#daily-metrics',
            severity: 'success',
            title: 'Daily KPI Report · {{input.reportDate}}',
            message: 'Revenue: ${{steps.calc_kpi.output.revenueToday}} | Signups: {{steps.calc_kpi.output.newSignups}} | ARPU: ${{steps.calc_kpi.output.arpu}} | CRM Leads: {{steps.calc_kpi.output.storedLeads}}',
          },
        },
        {
          id: 'email_digest',
          type: 'email',
          label: 'Email Executive Summary',
          position: { x: 940, y: 265 },
          config: {
            provider: 'sink',
            to: '{{input.execEmail}}',
            subject: 'Daily KPI Digest ({{input.reportDate}}) — ${{steps.calc_kpi.output.revenueToday}}',
            body: 'Daily snapshot: ${{steps.calc_kpi.output.revenueToday}} revenue across {{steps.calc_kpi.output.newSignups}} new signups (ARPU ${{steps.calc_kpi.output.arpu}}).',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'list_leads', condition: 'always' },
        { id: 'e2', from: 'list_leads', to: 'calc_kpi', condition: 'always' },
        { id: 'e3', from: 'calc_kpi', to: 'slack_digest', condition: 'always' },
        { id: 'e4', from: 'calc_kpi', to: 'email_digest', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_saas_onboarding',
    name: 'SaaS Customer Onboarding & Provisioning',
    category: 'Platform',
    popular: true,
    summary:
      'Validates signup payload in QuickJS-WASM, allocates starter credits, provisions tenant state in DB with automatic rollback, and sends welcome email + webhook.',
    highlights: ['QuickJS-WASM Validator', 'Parallel Fan-Out', 'Atomic DB Rollback', 'Welcome Email'],
    sampleInput: {
      orgId: 'org_nova_01',
      email: 'founder@nova.dev',
      plan: 'pro',
      starterCredits: 150,
    },
    definition: {
      name: 'SaaS Customer Onboarding & Provisioning',
      description: 'End-to-end transactional onboarding Saga with automatic credit & DB rollback.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Customer Signed Up',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'validate',
          type: 'script',
          label: 'Validate Plan & Email (WASM)',
          position: { x: 330, y: 170 },
          config: {
            code: 'if (!input.email || !String(input.email).includes("@")) throw new Error("Invalid signup email"); return { orgId: input.orgId || "org_" + Date.now(), plan: input.plan || "pro", credits: Number(input.starterCredits || 100) };',
          },
        },
        {
          id: 'grant_credits',
          type: 'custom_task',
          label: 'Allocate Starter Credits',
          position: { x: 640, y: 75 },
          config: {
            handler: 'allocate_credits',
            compensationHandler: 'revert_credits',
            credits: '{{steps.validate.output.credits}}',
          },
        },
        {
          id: 'provision_db',
          type: 'database',
          label: 'Provision Tenant Config',
          position: { x: 640, y: 265 },
          config: {
            operation: 'set',
            collection: 'orgs',
            key: '{{steps.validate.output.orgId}}',
            value: { email: '{{input.email}}', plan: '{{steps.validate.output.plan}}', status: 'active' },
          },
        },
        {
          id: 'welcome_email',
          type: 'email',
          label: 'Send Onboarding Email',
          position: { x: 960, y: 170 },
          config: {
            provider: 'sink',
            to: '{{input.email}}',
            subject: 'Your {{steps.validate.output.plan}} workspace is live!',
            body: 'Org {{steps.validate.output.orgId}} has been provisioned with {{steps.validate.output.credits}} starter credits.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'validate', condition: 'always' },
        { id: 'e2', from: 'validate', to: 'grant_credits', condition: 'always' },
        { id: 'e3', from: 'validate', to: 'provision_db', condition: 'always' },
        { id: 'e4', from: 'grant_credits', to: 'welcome_email', condition: 'always' },
        { id: 'e5', from: 'provision_db', to: 'welcome_email', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_invoice_approval_sla',
    name: 'Treasury Wire & Expense Approval (HITL + SLA)',
    category: 'Finance',
    popular: true,
    summary:
      'Holds operating funds, pauses durably at a CFO Approval Gate with a 30-minute SLA auto-reject watchdog, and disburses or refunds atomically with email receipt.',
    highlights: ['HITL SLA Watchdog', 'Zero-Thread Park', 'Atomic Refund', 'Email Receipt'],
    sampleInput: {
      orderId: 'WIRE-7710',
      vendorEmail: 'billing@supplier.io',
      amount: 1250,
    },
    definition: {
      name: 'Treasury Wire & Expense Approval (HITL + SLA)',
      description: 'Durable human approval gate with automatic SLA timeout and exact atomic refund.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Expense / Wire Request',
          position: { x: 40, y: 170 },
          config: { triggerType: 'api' },
        },
        {
          id: 'hold_funds',
          type: 'custom_task',
          label: 'Hold Operating Funds',
          position: { x: 330, y: 170 },
          config: {
            handler: 'charge_payment',
            compensationHandler: 'refund_payment',
            amount: '{{input.amount}}',
          },
        },
        {
          id: 'cfo_gate',
          type: 'approval',
          label: 'CFO Approval Gate (30m SLA)',
          position: { x: 640, y: 170 },
          config: {
            approverRole: 'CFO / Finance Lead',
            prompt: 'Approve disbursement of ${{input.amount}} for {{input.orderId}}?',
            slaMinutes: 30,
            onTimeout: 'reject',
          },
        },
        {
          id: 'send_receipt',
          type: 'email',
          label: 'Send Remittance Receipt',
          position: { x: 960, y: 170 },
          config: {
            provider: 'sink',
            to: '{{input.vendorEmail}}',
            subject: 'Payment Disbursed: {{input.orderId}} (${{input.amount}})',
            body: 'Wire {{input.orderId}} for ${{input.amount}} was approved and released.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'hold_funds', condition: 'always' },
        { id: 'e2', from: 'hold_funds', to: 'cfo_gate', condition: 'always' },
        { id: 'e3', from: 'cfo_gate', to: 'send_receipt', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_batch_foreach',
    name: 'Multi-SKU Batch Order Fan-Out (for_each)',
    category: 'Batch',
    summary:
      'Dynamically iterates over any runtime cart array with bounded concurrency and atomic per-item inventory rollback on failure.',
    highlights: ['Dynamic for_each', 'Bounded Concurrency', 'Per-Item Compensation'],
    sampleInput: {
      batchId: 'BATCH-204',
      items: [
        { sku: 'SKU-PRO-900', qty: 1 },
        { sku: 'SKU-PRO-900', qty: 2 },
      ],
    },
    definition: {
      name: 'Multi-SKU Batch Order Fan-Out (for_each)',
      description: 'Processes variable-length cart arrays concurrently with exact Saga rollback.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Batch Order Payload',
          position: { x: 40, y: 170 },
          config: { triggerType: 'api' },
        },
        {
          id: 'reserve_lines',
          type: 'for_each',
          label: 'Reserve Each Line Item',
          position: { x: 350, y: 170 },
          config: {
            itemsExpression: '{{input.items}}',
            maxConcurrency: 4,
            mode: 'custom_task',
            itemHandler: 'reserve_inventory',
            itemCompensationHandler: 'release_inventory',
            itemConfig: { sku: '{{input.item.sku}}', qty: '{{input.item.qty}}' },
          },
        },
        {
          id: 'summarize',
          type: 'script',
          label: 'Summarize Reservations (WASM)',
          position: { x: 670, y: 170 },
          config: {
            code: 'const count = steps.reserve_lines?.succeededCount ?? 0; return { batchId: input.batchId || "batch", reservedItems: count, status: "reserved" };',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'reserve_lines', condition: 'always' },
        { id: 'e2', from: 'reserve_lines', to: 'summarize', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_ai_ticket_triage',
    name: 'AI Support Ticket Triage & Escalation',
    category: 'AI Ops',
    summary:
      'Classifies inbound tickets using LM Studio or Google Gemini, branches on urgency, opens an escalation approval gate for high-priority issues, and logs routine replies.',
    highlights: ['LM Studio / Gemini Step', 'Conditional Branch', 'Human Escalation'],
    sampleInput: {
      ticketId: 'TKT-982',
      customerEmail: 'ops@partner.io',
      subject: 'Double billing charge on enterprise invoice',
    },
    definition: {
      name: 'AI Support Ticket Triage & Escalation',
      description: 'LLM-powered ticket triage routing urgent tickets to humans and auto-resolving routine requests.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Support Ticket Webhook',
          position: { x: 40, y: 180 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'classify',
          type: 'ai_agent',
          label: 'Classify Urgency (AI)',
          position: { x: 330, y: 180 },
          config: {
            provider: 'default',
            systemPrompt: 'Classify support tickets. Respond strictly with JSON: {"urgent": boolean, "category": string, "summary": string}.',
            prompt: 'Ticket {{input.ticketId}} from {{input.customerEmail}}: {{input.subject}}',
            expectJson: true,
          },
        },
        {
          id: 'is_urgent',
          type: 'condition',
          label: 'Urgent Issue?',
          position: { x: 630, y: 180 },
          config: { expression: 'steps.classify.output.urgent === true' },
        },
        {
          id: 'escalate',
          type: 'approval',
          label: 'On-Call Escalation Gate',
          position: { x: 940, y: 80 },
          config: {
            approverRole: 'Support Lead',
            prompt: 'Escalate urgent ticket {{input.ticketId}}?',
            slaMinutes: 15,
            onTimeout: 'escalate',
          },
        },
        {
          id: 'auto_log',
          type: 'database',
          label: 'Archive Routine Ticket',
          position: { x: 940, y: 280 },
          config: {
            operation: 'set',
            collection: 'archived_tickets',
            key: '{{input.ticketId}}',
            value: { email: '{{input.customerEmail}}', subject: '{{input.subject}}', triaged: true },
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'classify', condition: 'always' },
        { id: 'e2', from: 'classify', to: 'is_urgent', condition: 'always' },
        { id: 'e3', from: 'is_urgent', to: 'escalate', condition: 'true', label: 'urgent' },
        { id: 'e4', from: 'is_urgent', to: 'auto_log', condition: 'false', label: 'routine' },
      ],
    },
  },
  {
    id: 'bp_webhook_fanout',
    name: 'Signed Webhook Fan-Out & Partner Sync',
    category: 'Commerce',
    summary:
      'Reshapes an order event declaratively with Transform and fans out concurrently to ERP, CRM, and Slack channels with automatic retry backoff.',
    highlights: ['Declarative Transform', 'Parallel Fan-Out', 'Retry Backoff'],
    sampleInput: {
      eventId: 'evt_7741',
      orderId: 'ORD-7741',
      total: 420,
      currency: 'USD',
    },
    definition: {
      name: 'Signed Webhook Fan-Out & Partner Sync',
      description: 'Normalizes events and fans out to multiple partner HTTP webhooks + Slack in parallel.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Commerce Event Trigger',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'normalize',
          type: 'transform',
          label: 'Shape Partner Envelope',
          position: { x: 340, y: 170 },
          config: {
            mappings: {
              eventId: '{{input.eventId}}',
              orderId: '{{input.orderId}}',
              amount: '{{input.total}}',
              currency: '{{input.currency}}',
              source: 'sagaflow',
            },
          },
        },
        {
          id: 'sync_erp',
          type: 'http_request',
          label: 'Sync ERP Webhook',
          position: { x: 660, y: 75 },
          config: {
            method: 'POST',
            url: '/api/sink/acme-commerce/erp-sync',
            body: '{{steps.normalize.output}}',
          },
        },
        {
          id: 'notify_ops',
          type: 'slack_discord',
          label: 'Post to #order-sync',
          position: { x: 660, y: 265 },
          config: {
            platform: 'slack',
            channelName: '#order-sync',
            severity: 'info',
            title: 'Order Synced: {{input.orderId}}',
            message: 'Dispatched {{input.currency}} {{input.total}} event to ERP partner.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'normalize', condition: 'always' },
        { id: 'e2', from: 'normalize', to: 'sync_erp', condition: 'always' },
        { id: 'e3', from: 'normalize', to: 'notify_ops', condition: 'always' },
      ],
    },
  },
  {
    id: 'bp_nested_kyc_pipeline',
    name: 'Multi-Step KYC Nested Sub-Workflow Pipeline',
    category: 'Compliance',
    summary:
      'Parent onboarding pipeline invokes an isolated published child Saga workflow with recursion guard (depth ≤ 5) and records immutable compliance audit proof.',
    highlights: ['Nested Sub-Workflow', 'Recursion Guard (Depth 5)', 'Compliance Audit'],
    sampleInput: {
      applicantId: 'app_5501',
      orderId: 'KYC-5501',
      sku: 'SKU-PRO-900',
      qty: 1,
      amount: 1500,
    },
    definition: {
      name: 'Multi-Step KYC Nested Sub-Workflow Pipeline',
      description: 'Invokes a reusable published child workflow and writes compliance audit lineage.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'KYC Application Received',
          position: { x: 40, y: 170 },
          config: { triggerType: 'api' },
        },
        {
          id: 'invoke_child',
          type: 'sub_workflow',
          label: 'Run Risk Check Sub-Flow',
          position: { x: 350, y: 170 },
          config: {
            workflowId: 'wf_conditional_router',
            input: { orderId: '{{input.orderId}}', amount: '{{input.amount}}' },
          },
        },
        {
          id: 'audit',
          type: 'custom_task',
          label: 'Record Compliance Audit',
          position: { x: 670, y: 170 },
          config: {
            handler: 'audit_log',
            summary: 'KYC child run {{steps.invoke_child.output.childRunId}} finished.',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'trigger', to: 'invoke_child', condition: 'always' },
        { id: 'e2', from: 'invoke_child', to: 'audit', condition: 'always' },
      ],
    },
  },
];
