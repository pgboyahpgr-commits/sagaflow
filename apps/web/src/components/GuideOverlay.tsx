import React from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Compass,
  Play,
  Sparkles,
  X,
} from 'lucide-react';

export type AppTab =
  | 'home'
  | 'studio'
  | 'ai'
  | 'runs'
  | 'approvals'
  | 'ledger'
  | 'automation'
  | 'dlq'
  | 'observability'
  | 'settings';

export interface GuideStep {
  tab: AppTab;
  title: string;
  subtitle: string;
  body: string;
  tip: string;
  actionLabel: string;
}

export const GUIDE_TOUR_STEPS: GuideStep[] = [
  {
    tab: 'studio',
    title: '1. Visual DAG Studio',
    subtitle: 'Build & version fault-tolerant Saga workflows',
    body: 'Drag steps from the bottom dock (Trigger, WASM, Saga Task, HTTP, Branch, Wait, Approval, or AI Agent), connect handles, inspect upstream templates, and click Publish + Run to launch an idempotent execution.',
    tip: 'Click any node to configure real database handlers, chaos fault injection, or click-to-copy {{steps.*}} templates.',
    actionLabel: 'Stay on Studio',
  },
  {
    tab: 'ai',
    title: '2. AI Automation Agent (LM Studio / Gemini)',
    subtitle: 'Automate tasks with local LLMs or Google AI Studio',
    body: 'Connect your local LM Studio server ($0 offline) or paste your Google AI Studio (Gemini) API key (encrypted via AES-256-GCM). Ask the agent in plain English to design & publish DAGs, launch Sagas, diagnose failures, or manage approvals.',
    tip: 'Use "Fetch Loaded Models" for LM Studio or click "Test Connection" to verify real live latency before automating.',
    actionLabel: 'Open AI Agent',
  },
  {
    tab: 'runs',
    title: '3. Live Runs & Resumable SSE Tracing',
    subtitle: 'Real-time DAG overlay & execution waterfall',
    body: 'Watch every step transition live over offset-resumable Server-Sent Events (SSE). Toggle between Live DAG and Waterfall Gantt view, expand attempts to inspect outputs/logs, or cancel in-flight Sagas cooperatively.',
    tip: 'Amber glowing nodes mean a workflow is durably paused at a Human Approval Gate with zero worker threads held.',
    actionLabel: 'Inspect Live Runs',
  },
  {
    tab: 'approvals',
    title: '4. Human-in-the-Loop Approval Gates',
    subtitle: 'Approve to resume · Reject to trigger atomic rollback',
    body: 'High-stakes workflows pause cleanly at approval nodes. Approving resumes downstream steps from checkpoint; rejecting automatically executes reverse-order database compensations (e.g. refunding held funds).',
    tip: 'Copy the External Callback URL to trigger approvals from Slack, email, or external microservices.',
    actionLabel: 'Review Approvals',
  },
  {
    tab: 'ledger',
    title: '5. Real State & Immutable Saga Ledger',
    subtitle: 'Zero mocks — live isolated tenant database tables',
    body: 'Verify every real SKU reservation, wallet debit, credit hold, KV write, and Webhook Sink delivery inside this tenant’s isolated DB. Every forward commit and inverse rollback records exact before/after proofs.',
    tip: 'Try rejecting the pending CFO wire transfer and come back here to see customer_wallet restored to the exact cent.',
    actionLabel: 'Open State & Ledger',
  },
  {
    tab: 'automation',
    title: '6. Secret Vault, Webhooks & UTC Cron',
    subtitle: 'AES-256-GCM Vault · HMAC-SHA256 · 5-Field Cron',
    body: 'Store encrypted secrets that auto-redact as [REDACTED] in all logs, sign & fire real public inbound webhooks, or schedule recurring 5-field UTC cron jobs with minute-bucket deduplication.',
    tip: 'Select any saved secret in the Inbound Webhook panel to compute a real HMAC-SHA256 signature.',
    actionLabel: 'Explore Automation',
  },
  {
    tab: 'settings',
    title: '7. Settings, Guide Mode & Storage Anywhere',
    subtitle: 'Control Guide Mode, Tenants, API Keys & Backends',
    body: 'Toggle Guide Mode on or off anytime right here (or via the topbar Guide button), provision physically isolated tenant DBs, generate SHA-256 API keys, or switch storage between SQLite, JSON folders, and PostgreSQL RLS.',
    tip: 'You can re-launch this interactive walkthrough anytime from Settings → Guide Mode.',
    actionLabel: 'Finish Tour',
  },
];

const TAB_GUIDE_CONTENT: Record<
  AppTab,
  { badge: string; title: string; summary: string; steps: string[]; cta?: { label: string; tab?: AppTab } }
> = {
  home: {
    badge: 'GUIDE · HOME',
    title: 'Manage Projects & Launch Popular Automations',
    summary:
      'Create an empty isolated project or start from 10 ready-to-run automation templates (Lead Capture, Support Router, Uptime Monitor, KPI Digest, and more).',
    steps: ['Click + New Project for an empty or template workspace', 'Pick any popular template to install in 1 click', 'Open Builder to customize visually'],
    cta: { label: 'Open Builder →', tab: 'studio' },
  },
  studio: {
    badge: 'GUIDE · STUDIO',
    title: 'Design, Validate & Publish Visual Sagas',
    summary:
      'Pick a seeded workflow on the left or click + New. Add nodes from the bottom dock—including AI Agent and Approval Gate—then Save, Publish, and Run.',
    steps: ['Select any node to edit config & retry rules', 'Use Upstream Data Picker for {{steps.*}}', 'Click Run to execute live'],
    cta: { label: 'Automate with AI Agent →', tab: 'ai' },
  },
  ai: {
    badge: 'GUIDE · AI AGENT',
    title: 'Real Autonomous Agent — LM Studio (Local) or Google AI Studio (Gemini)',
    summary:
      'Choose your provider on the left, enter your Gemini API key or LM Studio URL, test the connection, then type any automation goal to build workflows, run Sagas, or resolve approvals.',
    steps: ['Select LM Studio or Google AI Studio', 'Save & click Test Connection', 'Send a prompt or click a Starter Chip'],
  },
  runs: {
    badge: 'GUIDE · LIVE RUNS',
    title: 'Inspect Real-Time Execution, Waterfall & SSE Event Stream',
    summary:
      'Every run shows color-coded step states on the Live DAG plus attempt-level traces and resumable SSE logs. Click any node to jump straight to its trace.',
    steps: ['Switch Live DAG ↔ Waterfall view', 'Expand any step for inputs, outputs & logs', 'Click Open Approval Gate on paused runs'],
    cta: { label: 'Open Approvals →', tab: 'approvals' },
  },
  approvals: {
    badge: 'GUIDE · APPROVAL GATES',
    title: 'Crash-Resumable Human-in-the-Loop Decisions',
    summary:
      'Workflows paused here consume zero worker threads. Approve & Resume continues downstream steps; Reject & Rollback automatically refunds prior DB mutations.',
    steps: ['Inspect the upstream checkpoint payload', 'Click Approve & Resume or Reject & Rollback', 'Or copy the External Callback cURL'],
    cta: { label: 'Verify DB State →', tab: 'ledger' },
  },
  ledger: {
    badge: 'GUIDE · ZERO-MOCK STATE',
    title: 'Live Per-Tenant Transactional Database & Saga Ledger',
    summary:
      'Every stock hold, wallet debit, credit lock, KV entry, and HTTP webhook sink hit lives in real isolated tenant storage with atomic before/after rollback proofs.',
    steps: ['Restock SKUs or top-up wallets live', 'Inspect Saga Ledger commits vs rollbacks', 'View real HTTP hits in Webhook Sink'],
  },
  automation: {
    badge: 'GUIDE · AUTOMATION',
    title: 'AES-256-GCM Secret Vault, HMAC Webhooks & UTC Cron',
    summary:
      'Encrypt secrets at rest (auto-redacted in logs), fire signed public inbound webhooks, or schedule recurring 5-field UTC cron jobs.',
    steps: ['Add an encrypted secret', 'Compute HMAC-SHA256 & Fire Live Webhook', 'Add a Cron schedule & click Run Now'],
  },
  dlq: {
    badge: 'GUIDE · DEAD-LETTER QUEUE',
    title: 'Inspect Permanent Failures & 1-Click Idempotent Replay',
    summary:
      'When a Saga exhausts retries and completes reverse compensation, its exact error context and input payload are captured here for safe replay.',
    steps: ['Review the failed step & error message', 'Click Replay Run to spawn a fresh idempotent attempt'],
  },
  observability: {
    badge: 'GUIDE · METRICS & LOAD LAB',
    title: 'Live Latency Percentiles, Stress Benchmark & Prometheus',
    summary:
      'Monitor real p50/p95/p99 latency from tenant DB runs, launch 25–500 concurrent workflows in the Load Lab, or inspect raw Prometheus /api/metrics.',
    steps: ['Click Inspect /api/metrics for OpenMetrics text', 'Pick a workflow & click Launch 50 Runs'],
  },
  settings: {
    badge: 'GUIDE · SETTINGS',
    title: 'Configure Guide Mode, AI Engine, Tenants & API Keys',
    summary:
      'Control onboarding helpers, switch or provision isolated tenant databases, mint SHA-256 API keys, and view your active storage driver.',
    steps: ['Toggle Guide Mode ON/OFF anytime', 'Restart the 7-step Interactive Tour', 'Provision a new isolated tenant DB'],
  },
};

export const ContextualGuideBanner: React.FC<{
  tab: AppTab;
  enabled: boolean;
  dismissed: boolean;
  onDismiss: () => void;
  onStartTour: () => void;
  onNavigate: (tab: AppTab) => void;
}> = ({ tab, enabled, dismissed, onDismiss, onStartTour, onNavigate }) => {
  if (!enabled || dismissed) return null;
  const info = TAB_GUIDE_CONTENT[tab];

  return (
    <div className="border-b border-[#262c32] bg-[#111417] px-3.5 py-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-[#22e55c] px-2 py-0.5 font-mono text-[9px] font-bold tracking-[0.06em] text-[#070b07]">
            {info.badge}
          </span>
          <div className="truncate text-[11.5px] text-[#f1f5f9]">
            <span className="font-semibold">{info.title}:</span>{' '}
            <span className="text-[#808d99]">{info.summary}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {info.cta?.tab && (
            <button
              onClick={() => onNavigate(info.cta!.tab!)}
              className="whitespace-nowrap rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#22e55c] transition hover:bg-[#22e55c]/15"
            >
              {info.cta.label}
            </button>
          )}
          <button
            onClick={onStartTour}
            className="sf-btn-secondary inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
          >
            <Play className="h-2.5 w-2.5 text-[#22e55c]" />
            7-Step Tour
          </button>
          <button
            onClick={onDismiss}
            title="Hide tip for this tab"
            className="rounded p-0.5 text-[#808d99] transition hover:bg-[#1c2227] hover:text-[#f1f5f9]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const GuideTourCard: React.FC<{
  stepIndex: number;
  onStepChange: (nextIndex: number) => void;
  onClose: () => void;
}> = ({ stepIndex, onStepChange, onClose }) => {
  const step = GUIDE_TOUR_STEPS[stepIndex] ?? GUIDE_TOUR_STEPS[0];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === GUIDE_TOUR_STEPS.length - 1;
  const pct = Math.round(((stepIndex + 1) / GUIDE_TOUR_STEPS.length) * 100);

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[370px] max-w-[calc(100vw-2rem)] rounded-lg border border-[#2f373f] bg-[#181d22] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded border border-[#22e55c]/40 bg-[#22e55c]/[0.10] text-[#22e55c]">
            {step.tab === 'ai' ? <Bot className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
          </div>
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-[#22e55c]">
              Interactive Guide · Step {stepIndex + 1} / {GUIDE_TOUR_STEPS.length}
            </div>
            <h4 className="text-sm font-semibold text-[#f1f5f9]">{step.title}</h4>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-[#f1f5f9]"
          title="Close guided tour"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-[#262c32]">
        <div
          className="h-full bg-[#22e55c] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-[#c7d1db]">{step.body}</p>

      <div className="mt-2.5 flex items-start gap-2 rounded border border-[#262c32] bg-[#111417] px-3 py-2 text-[11px] text-[#808d99]">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#22e55c]" />
        <span>{step.tip}</span>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-2">
        <button
          onClick={() => onStepChange(Math.max(0, stepIndex - 1))}
          disabled={isFirst}
          className="sf-btn-secondary inline-flex items-center gap-1 px-2.5 py-1.5 font-mono text-[11px] disabled:opacity-35"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>

        <div className="flex items-center gap-1">
          {GUIDE_TOUR_STEPS.map((_, idx) => (
            <button
              key={idx}
              onClick={() => onStepChange(idx)}
              className={`h-1.5 rounded-[1px] transition-all ${
                idx === stepIndex ? 'w-4 bg-[#22e55c]' : 'w-1.5 bg-[#262c32] hover:bg-[#808d99]'
              }`}
              title={`Jump to step ${idx + 1}`}
            />
          ))}
        </div>

        {isLast ? (
          <button
            onClick={onClose}
            className="sf-btn-primary inline-flex items-center gap-1 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Finish
          </button>
        ) : (
          <button
            onClick={() => onStepChange(stepIndex + 1)}
            className="sf-btn-primary inline-flex items-center gap-1 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end font-mono text-[10px] text-[#808d99]">
        <span className="inline-flex items-center gap-1">
          <ArrowRight className="h-2.5 w-2.5 text-[#22e55c]" />
          Toggle Guide Mode anytime in Settings
        </span>
      </div>
    </div>
  );
};
