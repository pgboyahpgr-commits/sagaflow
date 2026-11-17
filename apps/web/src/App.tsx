import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Home,
  Workflow as WorkflowIcon,
  Activity,
  Plug,
  Bot,
  Sliders,
  Search,
  Plus,
  HelpCircle,
  LogIn,
  LogOut,
  ChevronDown,
  FolderPlus,
  FilePlus2,
  BookTemplate,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
  Check,
  UserCheck,
  AlertTriangle,
  Database,
  Webhook,
  BarChart3,
  Layers,
} from 'lucide-react';
import type {
  AiProviderConfig,
  AuthUser,
  ProjectSummary,
  RunSummary,
  Tenant,
  WorkflowListItem,
} from '@sagaflow/shared';
import { api, DEMO_USER_ID, type HealthResponse, type TenantSession } from './lib/api';
import { HomeView } from './components/HomeView';
import { WorkflowStudio } from './components/WorkflowStudio';
import { AiAgentView } from './components/AiAgentView';
import { RunsView } from './components/RunsView';
import { ApprovalsView } from './components/ApprovalsView';
import { LedgerView } from './components/LedgerView';
import { AutomationView } from './components/AutomationView';
import { DlqView } from './components/DlqView';
import { ObservabilityView } from './components/ObservabilityView';
import { SettingsView } from './components/SettingsView';
import { AuthModal } from './components/AuthModal';
import { CommandPalette } from './components/CommandPalette';
import {
  ContextualGuideBanner,
  GuideTourCard,
  type AppTab,
} from './components/GuideOverlay';

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'err' | 'info';
}

const JWT_STORAGE_KEY = 'sagaflow_jwt_token';
const GUIDE_MODE_KEY = 'sagaflow_guide_mode_v7';
const DISMISSED_GUIDES_KEY = 'sagaflow_dismissed_guides';

type PrimaryNavGroup = 'home' | 'builder' | 'activity' | 'integrations' | 'ai' | 'settings';

function getGroupForTab(t: AppTab): PrimaryNavGroup {
  if (t === 'home') return 'home';
  if (t === 'studio') return 'builder';
  if (t === 'runs' || t === 'approvals' || t === 'dlq') return 'activity';
  if (t === 'automation' || t === 'ledger' || t === 'observability') return 'integrations';
  if (t === 'ai') return 'ai';
  return 'settings';
}

const TAB_TITLES: Record<AppTab, string> = {
  home: 'Home',
  studio: 'Builder',
  ai: 'AI Copilot',
  runs: 'Activity / Runs',
  approvals: 'Activity / Approvals',
  dlq: 'Activity / Dead-Letter Queue',
  automation: 'Integrations / Triggers & Alerts',
  ledger: 'Integrations / Database & Inbox',
  observability: 'Integrations / Metrics',
  settings: 'Settings',
};

export function App() {
  const [tab, setTab] = useState<AppTab>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [quickNewOpen, setQuickNewOpen] = useState(false);

  // Create Project modal controller (shared between Home, Sidebar switcher, and Topbar "+ New")
  const [createProjectModal, setCreateProjectModal] = useState<{
    open: boolean;
    mode: 'empty' | 'template';
    templateId: string | null;
  }>({ open: false, mode: 'empty', templateId: null });

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string>('ten_acme');
  const [activeUserId, setActiveUserId] = useState<string>(DEMO_USER_ID);
  const [activeApiKey, setActiveApiKey] = useState<string>('');
  const [authToken, setAuthToken] = useState<string>(
    () => localStorage.getItem(JWT_STORAGE_KEY) ?? ''
  );
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null);
  const [focusedWorkflowId, setFocusedWorkflowId] = useState<string | null>(null);
  const [openDlqCount, setOpenDlqCount] = useState<number>(0);
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState<number>(0);
  const [aiConfig, setAiConfig] = useState<AiProviderConfig | null>(null);
  const [paletteWorkflows, setPaletteWorkflows] = useState<WorkflowListItem[]>([]);
  const [paletteRuns, setPaletteRuns] = useState<RunSummary[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  // Guide Mode is calm & OFF by default in v7; toggleable anytime in 1 click via topbar "?" or Settings
  const [guideMode, setGuideMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(GUIDE_MODE_KEY);
    return saved === 'true';
  });
  const [dismissedTabs, setDismissedTabs] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(DISMISSED_GUIDES_KEY) ?? '{}') as Record<
        string,
        boolean
      >;
    } catch {
      return {};
    }
  });
  const [tourStep, setTourStep] = useState<number | null>(null);

  const toggleGuideMode = useCallback((next: boolean) => {
    setGuideMode(next);
    localStorage.setItem(GUIDE_MODE_KEY, String(next));
    if (!next) setTourStep(null);
  }, []);

  const dismissTabGuide = useCallback((targetTab: AppTab) => {
    setDismissedTabs((prev) => {
      const updated = { ...prev, [targetTab]: true };
      localStorage.setItem(DISMISSED_GUIDES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const restoreAllTips = useCallback(() => {
    setDismissedTabs({});
    localStorage.removeItem(DISMISSED_GUIDES_KEY);
    setGuideMode(true);
    localStorage.setItem(GUIDE_MODE_KEY, 'true');
  }, []);

  const notify = useCallback((message: string, tone: 'ok' | 'err' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  // Global ⌘K / Ctrl+K shortcut for Command Palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const loadBootstrap = useCallback(
    async (selectProjectId?: string) => {
      try {
        setBootError(null);
        const [h, t, p] = await Promise.all([
          api.health(),
          api.listTenants(),
          api.listProjects(),
        ]);
        setHealth(h);
        setProjects(p.projects);

        let availableTenants = t.tenants;
        if (authToken) {
          try {
            const me = await api.authMe(authToken);
            setAuthUser(me.user);
            if (me.tenants.length > 0) availableTenants = me.tenants;
          } catch {
            localStorage.removeItem(JWT_STORAGE_KEY);
            setAuthToken('');
            setAuthUser(null);
          }
        } else {
          setAuthUser(null);
        }

        setTenants(availableTenants);
        if (selectProjectId && availableTenants.some((x) => x.id === selectProjectId)) {
          setActiveTenantId(selectProjectId);
          setActiveApiKey('');
        } else if (
          availableTenants.length > 0 &&
          !availableTenants.some((x) => x.id === activeTenantId)
        ) {
          setActiveTenantId(availableTenants[0].id);
        }
      } catch (err) {
        setBootError(err instanceof Error ? err.message : 'Unable to reach SagaFlow Engine API');
      }
    },
    [activeTenantId, authToken]
  );

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  const session: TenantSession = useMemo(
    () => ({
      tenantId: activeTenantId,
      userId: activeUserId,
      apiKey: activeApiKey || undefined,
      token: authToken || undefined,
    }),
    [activeTenantId, activeUserId, activeApiKey, authToken]
  );

  // Background lightweight badge & command palette refresh
  const refreshBadges = useCallback(async () => {
    if (!activeTenantId) return;
    try {
      const [dlqRes, apprRes, wfRes, runRes] = await Promise.all([
        api.listDlq(session),
        api.listApprovals(session, 'pending'),
        api.listWorkflows(session),
        api.listRuns(session, { limit: 10 }),
      ]);
      setOpenDlqCount(dlqRes.entries.filter((e) => !e.replayedRunId).length);
      setPendingApprovalsCount(apprRes.approvals.length);
      setPaletteWorkflows(wfRes.workflows);
      setPaletteRuns(runRes.runs);
    } catch {
      // ignore transient auth switch
    }
  }, [activeTenantId, session]);

  useEffect(() => {
    void refreshBadges();
    const id = setInterval(() => void refreshBadges(), 7000);
    return () => clearInterval(id);
  }, [refreshBadges]);

  useEffect(() => {
    if (!activeTenantId) return;
    api
      .getAiConfig(session)
      .then((res) => setAiConfig(res.config))
      .catch(() => {});
  }, [activeTenantId, session]);

  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null;
  const activeProject = projects.find((p) => p.id === activeTenantId) ?? null;
  const activeGroup = getGroupForTab(tab);

  const handleOpenWorkflow = useCallback((workflowId?: string) => {
    setFocusedWorkflowId(workflowId ?? null);
    setTab('studio');
  }, []);

  const handleInspectRun = useCallback((runId: string) => {
    setFocusedRunId(runId);
    setTab('runs');
  }, []);

  const handleRunStarted = useCallback(
    (runId: string) => {
      setFocusedRunId(runId);
      setTab('runs');
      void loadBootstrap();
    },
    [loadBootstrap]
  );

  const handleCreateBlankWorkflow = useCallback(async () => {
    try {
      const { workflow } = await api.createWorkflow(session, {
        name: `Untitled Workflow`,
        description: 'Created from scratch',
        nodes: [
          {
            id: 'trigger',
            type: 'trigger',
            label: 'Start Trigger',
            position: { x: 80, y: 180 },
            config: { triggerType: 'manual' },
          },
        ],
        edges: [],
      });
      await loadBootstrap();
      setFocusedWorkflowId(workflow.id);
      setTab('studio');
      notify('Created blank workflow — click Add Node to build!', 'ok');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to create workflow', 'err');
    }
  }, [session, loadBootstrap, notify]);

  const handleStartTour = useCallback(() => {
    setGuideMode(true);
    localStorage.setItem(GUIDE_MODE_KEY, 'true');
    setTourStep(0);
    setTab('studio');
  }, []);

  const handleAuthenticated = async (data: {
    user: AuthUser;
    token: string;
    tenants: Tenant[];
  }) => {
    localStorage.setItem(JWT_STORAGE_KEY, data.token);
    setAuthToken(data.token);
    setAuthUser(data.user);
    setTenants(data.tenants);
    if (data.tenants.length > 0) {
      setActiveTenantId(data.tenants[0].id);
    }
    setShowAuthModal(false);
    notify(`Signed in as ${data.user.name}`, 'ok');
    await loadBootstrap();
  };

  const handleLogout = async () => {
    await api.authLogout().catch(() => {});
    localStorage.removeItem(JWT_STORAGE_KEY);
    setAuthToken('');
    setAuthUser(null);
    notify('Signed out', 'info');
    await loadBootstrap();
  };

  const openCreateProjectModal = (
    mode: 'empty' | 'template' = 'empty',
    templateId: string | null = null
  ) => {
    setCreateProjectModal({ open: true, mode, templateId });
    setTab('home');
  };

  const activityBadge = pendingApprovalsCount + openDlqCount;

  const primaryNav: Array<{
    group: PrimaryNavGroup;
    targetTab: AppTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { group: 'home', targetTab: 'home', label: 'Home', icon: Home },
    { group: 'builder', targetTab: 'studio', label: 'Builder', icon: WorkflowIcon },
    {
      group: 'activity',
      targetTab: 'runs',
      label: 'Activity',
      icon: Activity,
      badge: activityBadge > 0 ? activityBadge : undefined,
    },
    { group: 'integrations', targetTab: 'automation', label: 'Integrations', icon: Plug },
    { group: 'ai', targetTab: 'ai', label: 'AI Copilot', icon: Bot },
  ];

  if (bootError) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0c0e10] p-6">
        <div className="max-w-md rounded-xl border border-[#262c32] bg-[#15191d] p-6 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-rose-400" />
          <h2 className="mt-3 text-base font-semibold text-white">Cannot reach SagaFlow Engine</h2>
          <p className="mt-1 text-xs text-[#808d99]">{bootError}</p>
          <button
            onClick={() => void loadBootstrap()}
            className="sf-btn-neon mt-4 rounded-md px-4 py-2 text-xs font-semibold"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0c0e10] text-[#f1f5f9]">
      {/* SINGLE CALM LEFT SIDEBAR (replaces duplicate 9-tab top bar + left icon rail) */}
      <aside
        className={`flex shrink-0 flex-col border-r border-[#1c2227] bg-[#111417] transition-all duration-200 ${
          sidebarCollapsed ? 'w-[64px]' : 'w-[228px]'
        }`}
      >
        {/* Brand Row */}
        <div className="flex h-12 items-center justify-between border-b border-[#1c2227] px-3.5">
          <button
            type="button"
            onClick={() => setTab('home')}
            className="flex min-w-0 items-center gap-2.5 text-left"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#22e55c]/40 bg-[#22e55c]/12 text-[#22e55c]">
              <Layers className="h-4 w-4" />
            </div>
            {!sidebarCollapsed && (
              <div className="flex items-center gap-1.5 truncate">
                <span className="text-sm font-bold tracking-tight text-[#f1f5f9]">SagaFlow</span>
                <span className="rounded bg-[#22e55c]/12 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold text-[#22e55c]">
                  v8
                </span>
              </div>
            )}
          </button>
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse sidebar"
              className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Project Switcher */}
        <div className="relative border-b border-[#1c2227] p-2.5">
          <button
            type="button"
            onClick={() => setProjectMenuOpen((v) => !v)}
            title={activeTenant?.name ?? 'Switch Project'}
            className={`flex w-full items-center justify-between gap-2 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-2 text-left transition hover:border-[#2f373f] ${
              sidebarCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-[#22e55c]" />
              {!sidebarCollapsed && (
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-[#f1f5f9]">
                    {activeTenant?.name ?? 'Project'}
                  </div>
                  <div className="truncate font-mono text-[10px] text-[#808d99]">
                    {activeProject ? `${activeProject.workflowCount} workflows` : 'workspace'}
                  </div>
                </div>
              )}
            </div>
            {!sidebarCollapsed && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#808d99]" />}
          </button>

          {projectMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setProjectMenuOpen(false)}
              />
              <div className="absolute left-2.5 top-[58px] z-40 w-60 overflow-hidden rounded-lg border border-[#2f373f] bg-[#15191d] p-1.5 shadow-2xl">
                <div className="px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#808d99]">
                  Switch Project
                </div>
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {tenants.map((t) => {
                    const isCurrent = t.id === activeTenantId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setActiveTenantId(t.id);
                          setActiveApiKey('');
                          setFocusedWorkflowId(null);
                          setProjectMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs transition ${
                          isCurrent
                            ? 'bg-[#22e55c]/12 font-semibold text-[#22e55c]'
                            : 'text-[#c7d1db] hover:bg-[#1c2227] hover:text-white'
                        }`}
                      >
                        <span className="truncate">{t.name}</span>
                        {isCurrent && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <div className="my-1.5 border-t border-[#262c32]" />
                <button
                  type="button"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    openCreateProjectModal('empty');
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium text-[#22e55c] hover:bg-[#22e55c]/10"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  New Empty Project...
                </button>
              </div>
            </>
          )}
        </div>

        {/* 5 Clean Primary Navigation Links */}
        <nav className="flex-1 space-y-1 p-2.5">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            const active = activeGroup === item.group;
            return (
              <button
                key={item.group}
                type="button"
                onClick={() => setTab(item.targetTab)}
                title={item.label}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-xs font-medium transition ${
                  sidebarCollapsed ? 'justify-center px-0' : ''
                } ${
                  active
                    ? 'bg-[#22e55c]/12 text-[#22e55c]'
                    : 'text-[#9aa6b2] hover:bg-[#181d22] hover:text-[#f1f5f9]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </div>
                {!sidebarCollapsed && item.badge !== undefined && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-amber-300">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Bottom Utility Section */}
        <div className="space-y-1 border-t border-[#1c2227] p-2.5">
          <button
            type="button"
            onClick={() => setTab('settings')}
            title="Settings"
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition ${
              sidebarCollapsed ? 'justify-center px-0' : ''
            } ${
              tab === 'settings'
                ? 'bg-[#22e55c]/12 text-[#22e55c]'
                : 'text-[#9aa6b2] hover:bg-[#181d22] hover:text-[#f1f5f9]'
            }`}
          >
            <Sliders className="h-4 w-4 shrink-0" />
            {!sidebarCollapsed && <span>Settings</span>}
          </button>

          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            title="OpenAPI 3.1 Interactive Docs"
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium text-[#9aa6b2] transition hover:bg-[#181d22] hover:text-[#f1f5f9] ${
              sidebarCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            <BookOpen className="h-4 w-4 shrink-0" />
            {!sidebarCollapsed && <span>API Docs</span>}
          </a>

          {sidebarCollapsed && (
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              title="Expand sidebar"
              className="flex w-full items-center justify-center rounded-md py-2 text-[#808d99] hover:bg-[#181d22] hover:text-white"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </div>
      </aside>

      {/* MAIN CONTENT SHELL */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* SLIM 48px CALM TOP HEADER */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-[#1c2227] bg-[#111417]/90 px-5">
          {/* Breadcrumb */}
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setTab('home')}
              className="truncate text-[#808d99] hover:text-[#f1f5f9]"
            >
              {activeTenant?.name ?? 'Workspace'}
            </button>
            <span className="text-[#2f373f]">/</span>
            <span className="truncate font-medium text-[#f1f5f9]">{TAB_TITLES[tab]}</span>
          </div>

          {/* Right Quick Actions */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCommandPalette(true)}
              className="inline-flex items-center gap-2 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-1.5 text-xs text-[#808d99] transition hover:border-[#2f373f] hover:text-[#f1f5f9]"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search...</span>
              <kbd className="rounded border border-[#262c32] bg-[#0c0e10] px-1 font-mono text-[10px] text-[#808d99]">
                ⌘K
              </kbd>
            </button>

            {/* Quick "+ New" Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setQuickNewOpen((v) => !v)}
                className="sf-btn-neon inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">New</span>
              </button>
              {quickNewOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setQuickNewOpen(false)}
                  />
                  <div className="absolute right-0 top-10 z-40 w-52 overflow-hidden rounded-lg border border-[#2f373f] bg-[#15191d] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      onClick={() => {
                        setQuickNewOpen(false);
                        openCreateProjectModal('empty');
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227]"
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-[#22e55c]" />
                      New Empty Project
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQuickNewOpen(false);
                        openCreateProjectModal('template', 'bp_lead_capture_crm');
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227]"
                    >
                      <BookTemplate className="h-3.5 w-3.5 text-[#22e55c]" />
                      Project from Template
                    </button>
                    <div className="my-1 border-t border-[#262c32]" />
                    <button
                      type="button"
                      onClick={() => {
                        setQuickNewOpen(false);
                        void handleCreateBlankWorkflow();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227]"
                    >
                      <FilePlus2 className="h-3.5 w-3.5 text-[#808d99]" />
                      Blank Workflow
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => toggleGuideMode(!guideMode)}
              title={guideMode ? 'Turn off Guide Tips' : 'Show Contextual Guide Tips'}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs transition ${
                guideMode
                  ? 'border-[#22e55c]/50 bg-[#22e55c]/12 text-[#22e55c]'
                  : 'border-[#262c32] bg-[#15191d] text-[#808d99] hover:text-[#f1f5f9]'
              }`}
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>

            {authUser ? (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-1.5 text-xs text-[#c7d1db] hover:text-white"
              >
                <span className="max-w-[90px] truncate">{authUser.name}</span>
                <LogOut className="h-3.5 w-3.5 text-[#808d99]" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowAuthModal(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-1.5 text-xs text-[#c7d1db] hover:border-[#2f373f] hover:text-white"
              >
                <LogIn className="h-3.5 w-3.5 text-[#22e55c]" />
                <span className="hidden sm:inline">Sign In</span>
              </button>
            )}
          </div>
        </header>

        {/* SUB-NAVIGATION BAR FOR GROUPED SPACES (Activity / Integrations) */}
        {activeGroup === 'activity' && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[#1c2227] bg-[#0c0e10] px-5 py-2">
            {[
              { id: 'runs' as const, label: 'Live Runs', icon: Activity },
              {
                id: 'approvals' as const,
                label: 'Approvals',
                icon: UserCheck,
                badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
              },
              {
                id: 'dlq' as const,
                label: 'Failed / DLQ',
                icon: AlertTriangle,
                badge: openDlqCount > 0 ? openDlqCount : undefined,
              },
            ].map((sub) => {
              const Icon = sub.icon;
              const isAct = tab === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => setTab(sub.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    isAct
                      ? 'bg-[#15191d] text-[#22e55c] ring-1 ring-[#262c32]'
                      : 'text-[#808d99] hover:text-[#f1f5f9]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {sub.label}
                  {sub.badge !== undefined && (
                    <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 font-mono text-[10px] text-amber-300">
                      {sub.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {activeGroup === 'integrations' && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[#1c2227] bg-[#0c0e10] px-5 py-2">
            {[
              { id: 'automation' as const, label: 'Triggers, Vault & Alerts', icon: Webhook },
              { id: 'ledger' as const, label: 'Database, Ledger & Inbox', icon: Database },
              { id: 'observability' as const, label: 'Metrics & Load Lab', icon: BarChart3 },
            ].map((sub) => {
              const Icon = sub.icon;
              const isAct = tab === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => setTab(sub.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    isAct
                      ? 'bg-[#15191d] text-[#22e55c] ring-1 ring-[#262c32]'
                      : 'text-[#808d99] hover:text-[#f1f5f9]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {sub.label}
                </button>
              );
            })}
          </div>
        )}

        {/* OPTIONAL CONTEXTUAL GUIDE BAR (Only visible when user turns Guide Mode ON) */}
        <ContextualGuideBanner
          tab={tab}
          enabled={guideMode}
          dismissed={Boolean(dismissedTabs[tab])}
          onDismiss={() => dismissTabGuide(tab)}
          onStartTour={handleStartTour}
          onNavigate={setTab}
        />

        {/* ACTIVE VIEW */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {tab === 'home' && (
            <HomeView
              session={session}
              projects={projects}
              activeProject={activeProject}
              health={health}
              onSelectProject={(id) => {
                setActiveTenantId(id);
                setActiveApiKey('');
                setFocusedWorkflowId(null);
              }}
              onProjectsChanged={loadBootstrap}
              onOpenBuilder={handleOpenWorkflow}
              onCreateBlankWorkflow={handleCreateBlankWorkflow}
              onOpenRun={handleInspectRun}
              onOpenAi={() => setTab('ai')}
              onNotify={notify}
              createModalOpen={createProjectModal.open}
              initialModalMode={createProjectModal.mode}
              initialTemplateId={createProjectModal.templateId}
              onCloseCreateModal={() =>
                setCreateProjectModal((prev) => ({ ...prev, open: false }))
              }
              onOpenCreateModal={(mode = 'empty', templateId) =>
                setCreateProjectModal({
                  open: true,
                  mode,
                  templateId: templateId ?? null,
                })
              }
            />
          )}
          {tab === 'studio' && (
            <WorkflowStudio
              session={session}
              tenantSlug={activeTenant?.slug ?? 'acme-commerce'}
              initialWorkflowId={focusedWorkflowId}
              onRunStarted={handleRunStarted}
              onOpenAiAgent={() => setTab('ai')}
              onNotify={notify}
            />
          )}
          {tab === 'ai' && (
            <AiAgentView
              session={session}
              onOpenWorkflow={handleOpenWorkflow}
              onInspectRun={handleInspectRun}
              onConfigUpdated={setAiConfig}
              onNotify={notify}
            />
          )}
          {tab === 'runs' && (
            <RunsView
              session={session}
              initialRunId={focusedRunId}
              onOpenApprovals={() => setTab('approvals')}
              onNotify={notify}
            />
          )}
          {tab === 'approvals' && (
            <ApprovalsView
              session={session}
              onInspectRun={handleInspectRun}
              onNotify={notify}
            />
          )}
          {tab === 'ledger' && (
            <LedgerView
              session={session}
              tenantSlug={activeTenant?.slug ?? 'acme-commerce'}
              onInspectRun={handleInspectRun}
              onNotify={notify}
            />
          )}
          {tab === 'automation' && (
            <AutomationView
              session={session}
              tenantSlug={activeTenant?.slug ?? 'acme-commerce'}
              onInspectRun={handleInspectRun}
              onNotify={notify}
            />
          )}
          {tab === 'dlq' && <DlqView session={session} onReplayed={handleInspectRun} />}
          {tab === 'observability' && <ObservabilityView session={session} onNotify={notify} />}
          {tab === 'settings' && (
            <SettingsView
              session={session}
              tenants={tenants}
              storageStatus={health?.storage ?? null}
              guideMode={guideMode}
              onToggleGuideMode={toggleGuideMode}
              onStartTour={handleStartTour}
              onResetDismissedGuides={() => {
                restoreAllTips();
                notify('All contextual guide tips restored', 'ok');
              }}
              aiConfig={aiConfig}
              onNavigate={setTab}
              onTenantCreated={() => loadBootstrap()}
              onSelectTenant={(id) => {
                setActiveTenantId(id);
                setActiveApiKey('');
                setActiveUserId(DEMO_USER_ID);
              }}
              onSwitchUser={(uid) => {
                setActiveUserId(uid);
                notify(`Switched active RBAC persona to ${uid}`, 'info');
              }}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {/* GLOBAL COMMAND PALETTE (⌘K) */}
      <CommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        workflows={paletteWorkflows}
        runs={paletteRuns}
        tenants={tenants}
        activeTenantId={activeTenantId}
        guideMode={guideMode}
        onNavigate={setTab}
        onOpenWorkflow={handleOpenWorkflow}
        onInspectRun={handleInspectRun}
        onSelectTenant={(id) => {
          setActiveTenantId(id);
          setActiveApiKey('');
        }}
        onToggleGuide={toggleGuideMode}
        onStartTour={handleStartTour}
      />

      {/* FLOATING 7-STEP INTERACTIVE GUIDE TOUR */}
      {tourStep !== null && (
        <GuideTourCard
          stepIndex={tourStep}
          onStepChange={(idx) => {
            setTourStep(idx);
            const tourTabs: AppTab[] = [
              'studio',
              'ai',
              'runs',
              'approvals',
              'ledger',
              'automation',
              'observability',
            ];
            if (tourTabs[idx]) setTab(tourTabs[idx]);
          }}
          onClose={() => setTourStep(null)}
        />
      )}

      {/* AUTH MODAL */}
      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onAuthenticated={(data) => void handleAuthenticated(data)}
        />
      )}

      {/* TOAST STACK */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2 rounded-md border px-3.5 py-2 font-mono text-xs font-medium shadow-2xl backdrop-blur-xl ${
              t.tone === 'ok'
                ? 'border-[#22e55c]/45 bg-[#111813]/95 text-[#73ff86]'
                : t.tone === 'err'
                  ? 'border-rose-500/45 bg-[#1b1215]/95 text-rose-200'
                  : 'border-[#2f373f] bg-[#15191d]/95 text-zinc-200'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                t.tone === 'ok'
                  ? 'bg-[#22e55c]'
                  : t.tone === 'err'
                    ? 'bg-rose-400'
                    : 'bg-zinc-400'
              }`}
            />
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
export default App;
