import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Home,
  Workflow as WorkflowIcon,
  Bot,
  Activity,
  UserCheck,
  Database,
  Webhook,
  AlertTriangle,
  BarChart3,
  Sliders,
  Compass,
  Building2,
  ArrowRight,
  X,
} from 'lucide-react';
import type { Tenant, WorkflowListItem, RunSummary } from '@sagaflow/shared';
import type { AppTab } from './GuideOverlay';

interface CommandItem {
  id: string;
  group: 'Navigation' | 'Workflows' | 'Recent Runs' | 'Workspaces' | 'Actions';
  label: string;
  meta?: string;
  icon: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
}

export const CommandPalette: React.FC<{
  open: boolean;
  onClose: () => void;
  workflows: WorkflowListItem[];
  runs: RunSummary[];
  tenants: Tenant[];
  activeTenantId: string;
  guideMode: boolean;
  onNavigate: (tab: AppTab) => void;
  onOpenWorkflow: (workflowId: string) => void;
  onInspectRun: (runId: string) => void;
  onSelectTenant: (tenantId: string) => void;
  onToggleGuide: (next: boolean) => void;
  onStartTour: () => void;
}> = ({
  open,
  onClose,
  workflows,
  runs,
  tenants,
  activeTenantId,
  guideMode,
  onNavigate,
  onOpenWorkflow,
  onInspectRun,
  onSelectTenant,
  onToggleGuide,
  onStartTour,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const nav: CommandItem[] = [
      { id: 'nav-home', group: 'Navigation', label: 'Home & Projects', meta: 'Projects, templates & overview', icon: Home, onSelect: () => onNavigate('home') },
      { id: 'nav-studio', group: 'Navigation', label: 'Workflow Builder', meta: 'Visual DAG canvas & 16 node types', icon: WorkflowIcon, onSelect: () => onNavigate('studio') },
      { id: 'nav-ai', group: 'Navigation', label: 'AI Copilot', meta: 'LM Studio & Google AI Studio', icon: Bot, onSelect: () => onNavigate('ai') },
      { id: 'nav-runs', group: 'Navigation', label: 'Activity · Live Runs', meta: 'Real-time DAG traces & time-travel', icon: Activity, onSelect: () => onNavigate('runs') },
      { id: 'nav-approvals', group: 'Navigation', label: 'Activity · Approvals', meta: 'Human-in-the-loop sign-off & SLA', icon: UserCheck, onSelect: () => onNavigate('approvals') },
      { id: 'nav-dlq', group: 'Navigation', label: 'Activity · Dead-Letter Queue', meta: 'Inspect & replay failures', icon: AlertTriangle, onSelect: () => onNavigate('dlq') },
      { id: 'nav-auto', group: 'Navigation', label: 'Integrations · Triggers & Alerts', meta: 'Secrets, webhooks, cron & alert rules', icon: Webhook, onSelect: () => onNavigate('automation') },
      { id: 'nav-ledger', group: 'Navigation', label: 'Integrations · Database & Inbox', meta: 'Live DB tables, emails & chat sink', icon: Database, onSelect: () => onNavigate('ledger') },
      { id: 'nav-metrics', group: 'Navigation', label: 'Integrations · Metrics & Load Lab', meta: 'Latency p95 & Prometheus', icon: BarChart3, onSelect: () => onNavigate('observability') },
      { id: 'nav-settings', group: 'Navigation', label: 'Settings & Guide Controls', meta: 'Projects, RBAC, API keys & deploy', icon: Sliders, onSelect: () => onNavigate('settings') },
    ];

    const wfItems: CommandItem[] = workflows.map((wf) => ({
      id: `wf-${wf.id}`,
      group: 'Workflows',
      label: wf.name,
      meta: `${wf.id} · ${wf.status}${wf.latestVersion ? ` v${wf.latestVersion}` : ''}`,
      icon: WorkflowIcon,
      onSelect: () => onOpenWorkflow(wf.id),
    }));

    const runItems: CommandItem[] = runs.slice(0, 6).map((r) => ({
      id: `run-${r.id}`,
      group: 'Recent Runs',
      label: `${r.workflowName} (${r.status})`,
      meta: `${r.id}${r.durationMs ? ` · ${r.durationMs}ms` : ''}`,
      icon: Activity,
      onSelect: () => onInspectRun(r.id),
    }));

    const tenantItems: CommandItem[] = tenants.map((t) => ({
      id: `ten-${t.id}`,
      group: 'Workspaces',
      label: `Switch Tenant → ${t.name}`,
      meta: t.id === activeTenantId ? `${t.slug} · ACTIVE` : t.slug,
      icon: Building2,
      onSelect: () => onSelectTenant(t.id),
    }));

    const actions: CommandItem[] = [
      {
        id: 'act-tour',
        group: 'Actions',
        label: 'Launch 7-Step Interactive Product Tour',
        meta: 'Walk through every SagaFlow module',
        icon: Compass,
        onSelect: () => onStartTour(),
      },
      {
        id: 'act-guide',
        group: 'Actions',
        label: guideMode ? 'Turn OFF Interactive Guide Mode' : 'Turn ON Interactive Guide Mode',
        meta: 'Toggle contextual helper banners',
        icon: Compass,
        onSelect: () => onToggleGuide(!guideMode),
      },
    ];

    return [...wfItems, ...nav, ...runItems, ...actions, ...tenantItems];
  }, [
    workflows,
    runs,
    tenants,
    activeTenantId,
    guideMode,
    onNavigate,
    onOpenWorkflow,
    onInspectRun,
    onSelectTenant,
    onToggleGuide,
    onStartTour,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 14);
    return items
      .filter((i) => i.label.toLowerCase().includes(q) || (i.meta ?? '').toLowerCase().includes(q) || i.group.toLowerCase().includes(q))
      .slice(0, 16);
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((idx) => (filtered.length ? (idx + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((idx) => (filtered.length ? (idx - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter' && filtered[activeIndex]) {
        e.preventDefault();
        filtered[activeIndex].onSelect();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIndex, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="sf-top-neon w-full max-w-xl overflow-hidden rounded-lg border border-[#2f373f] bg-[#181d22] shadow-[0_12px_32px_rgba(0,0,0,0.65)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-[#262c32] px-4 py-3">
          <Search className="h-4 w-4 text-[#22e55c]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to workflow, live run, tab, tenant, or command..."
            className="flex-1 bg-transparent font-mono text-xs text-[#f1f5f9] placeholder-[#808d99] outline-none"
          />
          <button
            onClick={onClose}
            className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 font-mono text-[10px] text-[#808d99] hover:text-[#f1f5f9]"
          >
            ESC
          </button>
          <button onClick={onClose} className="text-[#808d99] hover:text-[#f1f5f9]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[400px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center font-mono text-xs text-[#808d99]">
              No matching workflows, runs, or commands.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const Icon = item.icon;
              const selected = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    item.onSelect();
                    onClose();
                  }}
                  className={`flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left transition ${
                    selected
                      ? 'bg-[#22e55c]/[0.10] text-[#f1f5f9] ring-1 ring-[#22e55c]/40'
                      : 'text-[#c7d1db] hover:bg-[#1c2227]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-[#22e55c]' : 'text-[#808d99]'}`} />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{item.label}</div>
                      {item.meta && (
                        <div className="truncate font-mono text-[10px] text-[#808d99]">{item.meta}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[#808d99]">
                      {item.group}
                    </span>
                    {selected && <ArrowRight className="h-3 w-3 text-[#22e55c]" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[#262c32] bg-[#111417] px-4 py-2 font-mono text-[10px] text-[#808d99]">
          <span>↑↓ Navigate · ↵ Open</span>
          <span className="text-[#22e55c]">SagaFlow Command Palette</span>
        </div>
      </div>
    </div>
  );
};
