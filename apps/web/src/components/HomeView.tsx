import React, { useMemo, useState } from 'react';
import {
  Plus,
  FolderPlus,
  Sparkles,
  Workflow as WorkflowIcon,
  Play,
  ArrowRight,
  Layers,
  CheckCircle2,
  Clock,
  AlertTriangle,
  X,
  Check,
  Container,
  Cloud,
  Laptop,
  Copy,
  ChevronDown,
  ChevronUp,
  FilePlus2,
  Rocket,
  FolderOpen,
} from 'lucide-react';
import type { ProjectSummary } from '@sagaflow/shared';
import { api, type HealthResponse, type TenantSession } from '../lib/api';
import { WORKFLOW_BLUEPRINTS, type WorkflowBlueprint } from './blueprints';

interface HomeViewProps {
  session: TenantSession;
  projects: ProjectSummary[];
  activeProject: ProjectSummary | null;
  health: HealthResponse | null;
  onSelectProject: (projectId: string) => void;
  onProjectsChanged: (selectProjectId?: string) => Promise<void>;
  onOpenBuilder: (workflowId?: string) => void;
  onCreateBlankWorkflow: () => Promise<void>;
  onOpenRun: (runId: string) => void;
  onOpenAi: () => void;
  onNotify: (message: string, tone?: 'ok' | 'err' | 'info') => void;
  createModalOpen: boolean;
  onCloseCreateModal: () => void;
  onOpenCreateModal: (initialMode?: 'empty' | 'template', preselectedTemplateId?: string) => void;
  initialModalMode?: 'empty' | 'template';
  initialTemplateId?: string | null;
}

const DEPLOY_COMMANDS = [
  {
    id: 'local',
    label: 'Local ($0)',
    icon: Laptop,
    summary: 'Zero external services — embedded SQLite DB-per-tenant on disk.',
    command: 'npm install && npm run build && npm start',
  },
  {
    id: 'docker',
    label: 'Docker',
    icon: Container,
    summary: 'Single self-contained container with persistent /app/data volume & healthcheck.',
    command: 'docker compose up --build',
  },
  {
    id: 'docker-scale',
    label: 'Docker Scale',
    icon: Layers,
    summary: 'Split API + replicated workers backed by PostgreSQL 17 RLS & NATS JetStream.',
    command: 'docker compose --profile scale up --build',
  },
  {
    id: 'cloud',
    label: 'Cloud (Fly / Render / Vercel)',
    icon: Cloud,
    summary: 'Includes ready-to-deploy fly.toml, render.yaml, vercel.json, and deploy/k8s/.',
    command: 'fly launch --no-deploy && fly volumes create sagaflow_data --size 1 && fly deploy',
  },
];

export const HomeView: React.FC<HomeViewProps> = ({
  session,
  projects,
  activeProject,
  health,
  onSelectProject,
  onProjectsChanged,
  onOpenBuilder,
  onCreateBlankWorkflow,
  onOpenRun,
  onOpenAi,
  onNotify,
  createModalOpen,
  onCloseCreateModal,
  onOpenCreateModal,
  initialModalMode = 'empty',
  initialTemplateId = null,
}) => {
  const [templateFilter, setTemplateFilter] = useState<string>('Popular');
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [showDeployGuide, setShowDeployGuide] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Create Project Modal state
  const [projectMode, setProjectMode] = useState<'empty' | 'template'>(initialModalMode);
  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>(
    initialTemplateId ? [initialTemplateId] : ['bp_lead_capture_crm']
  );
  const [creatingProject, setCreatingProject] = useState(false);

  // Sync modal mode/template whenever caller opens modal with preset
  React.useEffect(() => {
    if (createModalOpen) {
      setProjectMode(initialModalMode);
      if (initialTemplateId) {
        setSelectedTemplateIds([initialTemplateId]);
      } else if (initialModalMode === 'template' && selectedTemplateIds.length === 0) {
        setSelectedTemplateIds(['bp_lead_capture_crm']);
      }
      setProjectName('');
      setProjectSlug('');
      setProjectDesc('');
    }
  }, [createModalOpen, initialModalMode, initialTemplateId]);

  const categories = useMemo(() => {
    const cats = Array.from(new Set(WORKFLOW_BLUEPRINTS.map((b) => b.category)));
    return ['Popular', 'All', ...cats];
  }, []);

  const visibleTemplates = useMemo(() => {
    if (templateFilter === 'Popular') return WORKFLOW_BLUEPRINTS.filter((b) => b.popular);
    if (templateFilter === 'All') return WORKFLOW_BLUEPRINTS;
    return WORKFLOW_BLUEPRINTS.filter((b) => b.category === templateFilter);
  }, [templateFilter]);

  const handleUseTemplateInActiveProject = async (bp: WorkflowBlueprint) => {
    setCloningId(bp.id);
    try {
      const { workflow } = await api.createWorkflow(session, bp.definition);
      const published = await api.publishWorkflow(session, workflow.id);
      await onProjectsChanged();
      onNotify(`Added "${bp.name}" to ${activeProject?.name ?? 'project'}`, 'ok');
      onOpenBuilder(published.workflow.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to install template', 'err');
    } finally {
      setCloningId(null);
    }
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = projectName.trim();
    if (trimmedName.length < 2) {
      onNotify('Please enter a project name (at least 2 characters).', 'err');
      return;
    }

    setCreatingProject(true);
    try {
      const chosenBlueprints =
        projectMode === 'template'
          ? WORKFLOW_BLUEPRINTS.filter((b) => selectedTemplateIds.includes(b.id))
          : [];

      const res = await api.createProject({
        name: trimmedName,
        slug: projectSlug.trim() || undefined,
        description: projectDesc.trim() || undefined,
        mode: projectMode,
        starterWorkflows: chosenBlueprints.map((b) => b.definition),
        autoPublish: true,
        maxConcurrentRuns: 100,
        rateLimitPerMin: 300,
      });

      await onProjectsChanged(res.tenant.id);
      onCloseCreateModal();
      onNotify(
        projectMode === 'empty'
          ? `Created empty project "${res.tenant.name}" — ready to build!`
          : `Created project "${res.tenant.name}" with ${res.workflows.length} template(s).`,
        'ok'
      );

      // Jump straight into Builder so the user can start creating immediately
      if (res.workflows.length > 0) {
        onOpenBuilder(res.workflows[0].id);
      } else {
        onOpenBuilder();
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create project', 'err');
    } finally {
      setCreatingProject(false);
    }
  };

  const copyCommand = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(null), 1800);
  };

  const toggleTemplateSelection = (id: string) => {
    setSelectedTemplateIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const derivedSlugPreview =
    projectSlug.trim() ||
    projectName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    'my-project';

  return (
    <div className="h-full overflow-y-auto bg-[#0c0e10]">
      <div className="mx-auto max-w-[1220px] space-y-8 px-6 py-8 md:px-10">
        {/* HERO HEADER — Calm, spacious, focused */}
        <section className="flex flex-col justify-between gap-6 border-b border-[#1c2227] pb-7 lg:flex-row lg:items-end">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#262c32] bg-[#111417] px-3 py-1 font-mono text-[11px] text-[#808d99]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#22e55c]" />
              <span>Active Project:</span>
              <span className="font-semibold text-[#f1f5f9]">
                {activeProject?.name ?? 'Workspace'}
              </span>
              {health?.storage && (
                <>
                  <span className="text-[#2f373f]">·</span>
                  <span className="text-[#22e55c]">{health.storage.driver.toUpperCase()}</span>
                </>
              )}
              {health?.deployment?.ephemeralStorage && (
                <span
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                  title="This deployment has no persistent disk. Data resets when serverless instances recycle. Attach a PostgreSQL or libSQL database (DATABASE_URL) for durable storage."
                >
                  EPHEMERAL DEMO
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#f1f5f9] md:text-[28px]">
              Build reliable automations without the complexity
            </h1>
            <p className="max-w-2xl text-sm text-[#808d99]">
              Start an empty project, launch a popular workflow template in one click, or let the AI
              Copilot design durable Sagas with automatic rollbacks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => onOpenCreateModal('empty')}
              className="sf-btn-neon inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold"
            >
              <FolderPlus className="h-4 w-4" />
              New Project
            </button>
            <button
              onClick={() => void onCreateBlankWorkflow()}
              className="inline-flex items-center gap-2 rounded-md border border-[#262c32] bg-[#15191d] px-4 py-2 text-xs font-medium text-[#f1f5f9] transition hover:border-[#2f373f] hover:bg-[#1c2227]"
            >
              <FilePlus2 className="h-4 w-4 text-[#22e55c]" />
              Blank Workflow
            </button>
            <button
              onClick={onOpenAi}
              className="inline-flex items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/12 px-4 py-2 text-xs font-medium text-violet-200 transition hover:bg-violet-500/20"
            >
              <Sparkles className="h-4 w-4 text-violet-300" />
              Build with AI
            </button>
          </div>
        </section>

        {/* PROJECTS WORKSPACE GRID */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[#f1f5f9]">Your Projects</h2>
              <p className="text-xs text-[#808d99]">
                Each project has its own isolated database, workflows, secrets, and execution history.
              </p>
            </div>
            <button
              onClick={() => onOpenCreateModal('empty')}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#111417] px-3 py-1.5 text-xs font-medium text-[#c7d1db] transition hover:border-[#22e55c]/50 hover:text-[#22e55c]"
            >
              <Plus className="h-3.5 w-3.5" />
              Create Empty Project
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((proj) => {
              const isActive = proj.id === session.tenantId;
              return (
                <div
                  key={proj.id}
                  onClick={() => onSelectProject(proj.id)}
                  className={`group relative flex cursor-pointer flex-col justify-between rounded-lg border p-4 transition ${
                    isActive
                      ? 'border-[#22e55c]/60 bg-[#15191d] shadow-[0_0_24px_rgba(34,229,92,0.08)]'
                      : 'border-[#262c32] bg-[#111417] hover:border-[#2f373f] hover:bg-[#15191d]'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-md border ${
                            isActive
                              ? 'border-[#22e55c]/40 bg-[#22e55c]/12 text-[#22e55c]'
                              : 'border-[#262c32] bg-[#15191d] text-[#808d99] group-hover:text-[#f1f5f9]'
                          }`}
                        >
                          <FolderOpen className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#f1f5f9]">
                            {proj.name}
                          </div>
                          <div className="font-mono text-[11px] text-[#808d99]">/{proj.slug}</div>
                        </div>
                      </div>
                      {isActive && (
                        <span className="rounded-full bg-[#22e55c]/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#22e55c]">
                          Active
                        </span>
                      )}
                    </div>

                    <p className="mt-3 line-clamp-2 min-h-[32px] text-xs text-[#808d99]">
                      {proj.description ||
                        (proj.workflowCount === 0
                          ? 'Empty workspace ready for your first automation.'
                          : `${proj.publishedWorkflowCount} published of ${proj.workflowCount} workflow(s).`)}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-[#1c2227] pt-3">
                    <div className="flex items-center gap-3 font-mono text-[11px] text-[#808d99]">
                      <span>
                        <strong className="text-[#f1f5f9]">{proj.workflowCount}</strong> flows
                      </span>
                      <span>
                        <strong className="text-[#f1f5f9]">{proj.runCount}</strong> runs
                      </span>
                      {proj.pendingApprovals > 0 && (
                        <span className="text-amber-400">{proj.pendingApprovals} waiting</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectProject(proj.id);
                        onOpenBuilder(proj.recentWorkflows[0]?.id);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#22e55c] opacity-85 transition hover:opacity-100"
                    >
                      Open
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Inviting Empty Project Card */}
            <button
              type="button"
              onClick={() => onOpenCreateModal('empty')}
              className="flex min-h-[154px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#2f373f] bg-[#111417]/50 p-5 text-center transition hover:border-[#22e55c]/60 hover:bg-[#15191d]"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#262c32] bg-[#15191d] text-[#22e55c]">
                <Plus className="h-5 w-5" />
              </div>
              <div className="text-sm font-medium text-[#f1f5f9]">New Empty Project</div>
              <div className="max-w-[210px] text-xs text-[#808d99]">
                Clean isolated workspace or pre-loaded with starter templates
              </div>
            </button>
          </div>
        </section>

        {/* POPULAR AUTOMATION TEMPLATES */}
        <section className="space-y-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-sm font-semibold text-[#f1f5f9]">
                Popular Automation Templates
              </h2>
              <p className="text-xs text-[#808d99]">
                Ready-to-run real workflows using Email, Slack/Discord, Database, Switch, Filter,
                Transform, AI Agent, and Saga Rollbacks.
              </p>
            </div>
          </div>

          {/* Clean Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setTemplateFilter(cat)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  templateFilter === cat
                    ? 'border-[#22e55c]/60 bg-[#22e55c]/15 text-[#22e55c]'
                    : 'border-[#262c32] bg-[#111417] text-[#808d99] hover:border-[#2f373f] hover:text-[#f1f5f9]'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visibleTemplates.map((bp) => (
              <div
                key={bp.id}
                className="flex flex-col justify-between rounded-lg border border-[#262c32] bg-[#15191d] p-4 transition hover:border-[#2f373f]"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#22e55c]">
                      {bp.category}
                    </span>
                    <span className="font-mono text-[11px] text-[#808d99]">
                      {bp.definition.nodes.length} steps
                    </span>
                  </div>
                  <h3 className="mt-2.5 text-sm font-semibold text-[#f1f5f9]">{bp.name}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-[#808d99]">{bp.summary}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {bp.highlights.map((h) => (
                      <span
                        key={h}
                        className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[10.5px] text-[#c7d1db]"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-[#1c2227] pt-3">
                  <button
                    type="button"
                    disabled={cloningId === bp.id}
                    onClick={() => void handleUseTemplateInActiveProject(bp)}
                    className="sf-btn-neon flex-1 rounded-md py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    {cloningId === bp.id ? 'Installing...' : 'Use Template'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenCreateModal('template', bp.id)}
                    title="Create a brand-new project with this template"
                    className="rounded-md border border-[#262c32] bg-[#111417] px-2.5 py-1.5 text-xs text-[#c7d1db] transition hover:border-[#2f373f] hover:text-white"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* RECENT WORKFLOWS & RECENT ACTIVITY IN ACTIVE PROJECT */}
        {activeProject && (
          <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Workflows */}
            <div className="rounded-lg border border-[#262c32] bg-[#111417] p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#f1f5f9]">
                  Workflows in {activeProject.name}
                </h2>
                <button
                  type="button"
                  onClick={() => onOpenBuilder()}
                  className="text-xs font-medium text-[#22e55c] hover:underline"
                >
                  Open Builder →
                </button>
              </div>
              {activeProject.recentWorkflows.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-[#262c32] py-8 text-center">
                  <WorkflowIcon className="h-6 w-6 text-[#808d99]" />
                  <p className="mt-2 text-xs font-medium text-[#f1f5f9]">
                    This project is empty
                  </p>
                  <p className="mt-0.5 text-xs text-[#808d99]">
                    Create a blank workflow or pick a template above to get started.
                  </p>
                  <button
                    type="button"
                    onClick={() => void onCreateBlankWorkflow()}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[#22e55c]/40 bg-[#22e55c]/10 px-3 py-1.5 text-xs font-medium text-[#22e55c] hover:bg-[#22e55c]/20"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create First Workflow
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {activeProject.recentWorkflows.map((wf) => (
                    <button
                      key={wf.id}
                      type="button"
                      onClick={() => onOpenBuilder(wf.id)}
                      className="flex w-full items-center justify-between rounded-md border border-transparent bg-[#15191d] px-3 py-2.5 text-left transition hover:border-[#262c32]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-[#f1f5f9]">
                          {wf.name}
                        </div>
                        <div className="mt-0.5 font-mono text-[10.5px] text-[#808d99]">
                          {wf.nodeCount} nodes · {wf.latestVersion ? `v${wf.latestVersion}` : 'draft'}
                        </div>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#808d99]" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Runs */}
            <div className="rounded-lg border border-[#262c32] bg-[#111417] p-5">
              <div className="mb-3.5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#f1f5f9]">Recent Activity</h2>
                <span className="font-mono text-[11px] text-[#808d99]">
                  {activeProject.runCount} run(s)
                </span>
              </div>
              {activeProject.recentRuns.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-[#262c32] py-8 text-center">
                  <Play className="h-6 w-6 text-[#808d99]" />
                  <p className="mt-2 text-xs font-medium text-[#f1f5f9]">No runs yet</p>
                  <p className="mt-0.5 text-xs text-[#808d99]">
                    Publish and run a workflow to trace live steps and rollbacks here.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {activeProject.recentRuns.map((run) => {
                    const statusColor =
                      run.status === 'succeeded'
                        ? 'text-[#22e55c]'
                        : run.status === 'waiting_approval'
                          ? 'text-amber-400'
                          : run.status === 'compensated'
                            ? 'text-violet-400'
                            : 'text-rose-400';
                    const StatusIcon =
                      run.status === 'succeeded'
                        ? CheckCircle2
                        : run.status === 'waiting_approval'
                          ? Clock
                          : AlertTriangle;
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => onOpenRun(run.id)}
                        className="flex w-full items-center justify-between rounded-md border border-transparent bg-[#15191d] px-3 py-2.5 text-left transition hover:border-[#262c32]"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <StatusIcon className={`h-4 w-4 shrink-0 ${statusColor}`} />
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-[#f1f5f9]">
                              {run.workflowName}
                            </div>
                            <div className="mt-0.5 font-mono text-[10.5px] text-[#808d99]">
                              {run.status.replace('_', ' ')}
                              {run.durationMs != null ? ` · ${run.durationMs}ms` : ''}
                            </div>
                          </div>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#808d99]" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {/* RUN ANYWHERE (LOCAL / DOCKER / HOSTED CLOUD) COLLAPSIBLE BAR */}
        <section className="rounded-lg border border-[#262c32] bg-[#111417]">
          <button
            type="button"
            onClick={() => setShowDeployGuide((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-3.5 text-left"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#262c32] bg-[#15191d] text-[#22e55c]">
                <Container className="h-4 w-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-[#f1f5f9]">
                  Run Locally, in Docker, or Hosted Cloud
                </div>
                <div className="text-[11px] text-[#808d99]">
                  Zero lock-in: SQLite DB-per-tenant, JSON folders, or PostgreSQL RLS + NATS JetStream.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-[#808d99]">
              <span>{showDeployGuide ? 'Hide commands' : 'View deploy commands'}</span>
              {showDeployGuide ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </div>
          </button>

          {showDeployGuide && (
            <div className="grid grid-cols-1 gap-3 border-t border-[#1c2227] p-5 md:grid-cols-2">
              {DEPLOY_COMMANDS.map((item) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    className="rounded-md border border-[#262c32] bg-[#15191d] p-3.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#f1f5f9]">
                        <Icon className="h-3.5 w-3.5 text-[#22e55c]" />
                        {item.label}
                      </div>
                      <button
                        type="button"
                        onClick={() => copyCommand(item.id, item.command)}
                        className="inline-flex items-center gap-1 rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 font-mono text-[10px] text-[#c7d1db] hover:text-[#22e55c]"
                      >
                        {copiedCmd === item.id ? (
                          <>
                            <Check className="h-3 w-3 text-[#22e55c]" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-[#808d99]">{item.summary}</p>
                    <pre className="mt-2 overflow-x-auto rounded border border-[#1c2227] bg-[#0c0e10] px-2.5 py-1.5 font-mono text-[11px] text-[#22e55c]">
                      {item.command}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* CREATE PROJECT MODAL (EMPTY OR TEMPLATE) */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl overflow-hidden rounded-lg border border-[#2f373f] bg-[#15191d] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#262c32] px-5 py-4">
              <div className="flex items-center gap-2.5">
                <FolderPlus className="h-4 w-4 text-[#22e55c]" />
                <h2 className="text-sm font-semibold text-[#f1f5f9]">Create New Project</h2>
              </div>
              <button
                type="button"
                onClick={onCloseCreateModal}
                className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateProject(e)} className="space-y-4 p-5">
              {/* Mode selector: Empty Project vs Starter Template */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setProjectMode('empty')}
                  className={`rounded-lg border p-3.5 text-left transition ${
                    projectMode === 'empty'
                      ? 'border-[#22e55c] bg-[#22e55c]/10'
                      : 'border-[#262c32] bg-[#111417] hover:border-[#2f373f]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <FilePlus2
                      className={`h-4 w-4 ${
                        projectMode === 'empty' ? 'text-[#22e55c]' : 'text-[#808d99]'
                      }`}
                    />
                    {projectMode === 'empty' && (
                      <span className="h-2 w-2 rounded-full bg-[#22e55c]" />
                    )}
                  </div>
                  <div className="mt-2 text-xs font-semibold text-[#f1f5f9]">Empty Project</div>
                  <div className="mt-0.5 text-[11px] text-[#808d99]">
                    Clean isolated workspace with 0 workflows. Start fresh.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setProjectMode('template')}
                  className={`rounded-lg border p-3.5 text-left transition ${
                    projectMode === 'template'
                      ? 'border-[#22e55c] bg-[#22e55c]/10'
                      : 'border-[#262c32] bg-[#111417] hover:border-[#2f373f]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <Rocket
                      className={`h-4 w-4 ${
                        projectMode === 'template' ? 'text-[#22e55c]' : 'text-[#808d99]'
                      }`}
                    />
                    {projectMode === 'template' && (
                      <span className="h-2 w-2 rounded-full bg-[#22e55c]" />
                    )}
                  </div>
                  <div className="mt-2 text-xs font-semibold text-[#f1f5f9]">
                    From Popular Templates
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#808d99]">
                    Pre-install ready-to-run automation workflows.
                  </div>
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#c7d1db]">
                    Project Name
                  </label>
                  <input
                    required
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="e.g. Growth Automations"
                    className="w-full rounded-md border border-[#262c32] bg-[#111417] px-3 py-2 text-xs text-[#f1f5f9] outline-none focus:border-[#22e55c]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#c7d1db]">
                    URL Slug <span className="text-[#808d99]">(optional)</span>
                  </label>
                  <input
                    value={projectSlug}
                    onChange={(e) =>
                      setProjectSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }
                    placeholder={derivedSlugPreview}
                    className="w-full rounded-md border border-[#262c32] bg-[#111417] px-3 py-2 font-mono text-xs text-[#f1f5f9] outline-none focus:border-[#22e55c]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#c7d1db]">
                  Description <span className="text-[#808d99]">(optional)</span>
                </label>
                <input
                  value={projectDesc}
                  onChange={(e) => setProjectDesc(e.target.value)}
                  placeholder="What are you automating in this project?"
                  className="w-full rounded-md border border-[#262c32] bg-[#111417] px-3 py-2 text-xs text-[#f1f5f9] outline-none focus:border-[#22e55c]"
                />
              </div>

              {projectMode === 'template' && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-[#c7d1db]">
                    Select Starter Template(s) ({selectedTemplateIds.length} chosen)
                  </label>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border border-[#262c32] bg-[#111417] p-2">
                    {WORKFLOW_BLUEPRINTS.map((bp) => {
                      const checked = selectedTemplateIds.includes(bp.id);
                      return (
                        <button
                          key={bp.id}
                          type="button"
                          onClick={() => toggleTemplateSelection(bp.id)}
                          className={`flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-xs transition ${
                            checked
                              ? 'border border-[#22e55c]/40 bg-[#22e55c]/10 text-[#f1f5f9]'
                              : 'border border-transparent text-[#c7d1db] hover:bg-[#15191d]'
                          }`}
                        >
                          <div className="min-w-0 pr-2">
                            <div className="truncate font-medium">{bp.name}</div>
                            <div className="text-[10.5px] text-[#808d99]">
                              {bp.category} · {bp.definition.nodes.length} steps
                            </div>
                          </div>
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              checked
                                ? 'border-[#22e55c] bg-[#22e55c] text-[#070b07]'
                                : 'border-[#2f373f]'
                            }`}
                          >
                            {checked && <Check className="h-3 w-3 stroke-[3]" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-[#262c32] pt-4">
                <button
                  type="button"
                  onClick={onCloseCreateModal}
                  className="rounded-md border border-[#262c32] bg-[#111417] px-4 py-2 text-xs font-medium text-[#c7d1db] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingProject || (projectMode === 'template' && selectedTemplateIds.length === 0)}
                  className="sf-btn-neon inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {creatingProject
                    ? 'Creating...'
                    : projectMode === 'empty'
                      ? 'Create Empty Project'
                      : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
