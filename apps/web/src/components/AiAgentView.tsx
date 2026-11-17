import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Cpu,
  KeyRound,
  Send,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ExternalLink,
  Trash2,
  ShieldCheck,
  Zap,
  Sparkles,
  Loader2,
  RotateCcw,
  CornerDownLeft,
  Wrench,
} from 'lucide-react';
import type {
  AiAgentToolExecution,
  AiChatMessage,
  AiProvider,
  AiProviderConfig,
} from '@sagaflow/shared';
import { api, type TenantSession } from '../lib/api';

interface AiAgentViewProps {
  session: TenantSession;
  onOpenWorkflow: (workflowId: string) => void;
  onInspectRun: (runId: string) => void;
  onConfigUpdated?: (config: AiProviderConfig) => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

interface ChatThreadEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: AiProvider;
  model?: string;
  latencyMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  actions?: AiAgentToolExecution[];
  timestamp: string;
  isError?: boolean;
}

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', badge: 'FAST' },
  { id: 'gemini-2.5-pro', badge: 'PRO' },
  { id: 'gemini-2.0-flash', badge: '2.0' },
  { id: 'gemini-1.5-flash', badge: '1.5' },
];

const STARTER_TASKS = [
  {
    label: 'Build & Publish Fraud Approval Saga',
    tone: 'default' as const,
    prompt:
      'Create and publish a new workflow called "Enterprise Fraud Gate" that takes a webhook trigger, reserves SKU-PRO-900 inventory (with release_inventory compensator), charges payment (with refund_payment compensator), requires a CFO Human Approval Gate, and then posts to /api/sink/acme-commerce/fraud-approved.',
  },
  {
    label: 'Audit Live State & Recent Runs',
    tone: 'default' as const,
    prompt:
      'Summarize my current tenant warehouse inventory, account wallet balances, pending human approval gates, and recent workflow runs.',
  },
  {
    label: 'Build AI-Powered Order Triage DAG',
    tone: 'default' as const,
    prompt:
      'Create and publish a workflow that uses an ai_agent node to classify incoming support orders as priority "urgent" or "standard", branches with a condition node, and routes urgent tickets to a Support Lead approval gate.',
  },
  {
    label: 'Restock Low Inventory SKU (SKU-PRO-900)',
    tone: 'default' as const,
    prompt:
      'Add +250 units to SKU-PRO-900 in my tenant inventory and summarize the updated warehouse counts.',
  },
  {
    label: 'Diagnose DLQ & Replay Poison Messages',
    tone: 'danger' as const,
    prompt:
      'Check my Dead-Letter Queue (DLQ), explain exactly why the failed workflow rolled back, and tell me if it is safe to replay.',
  },
];

interface PreviewNode {
  id: string;
  type: string;
  label: string;
  compensationHandler?: string;
}

export const AiAgentView: React.FC<AiAgentViewProps> = ({
  session,
  onOpenWorkflow,
  onInspectRun,
  onConfigUpdated,
  onNotify,
}) => {
  const [config, setConfig] = useState<AiProviderConfig | null>(null);
  const [provider, setProvider] = useState<AiProvider>('lm_studio');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [googleModel, setGoogleModel] = useState('gemini-2.5-flash');
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState('http://localhost:1234/v1');
  const [lmStudioModel, setLmStudioModel] = useState('');
  const [lmStudioApiKey, setLmStudioApiKey] = useState('');
  const [temperature, setTemperature] = useState(0.2);

  const [lmModels, setLmModels] = useState<Array<{ id: string; ownedBy?: string }>>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    model: string;
    latencyMs: number;
    reply?: string;
    error?: string;
  } | null>(null);

  const [autoExecute, setAutoExecute] = useState(true);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [thread, setThread] = useState<ChatThreadEntry[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'SagaFlow AI Automation Agent ready. Connect your LM Studio local server (http://localhost:1234/v1) or your Google AI Studio (Gemini) API key on the left, then ask me to synthesize & publish fault-tolerant DAGs, launch idempotent Saga runs, audit SQLite DB state, schedule UTC cron jobs, or manage Human Approval Gates.',
      timestamp: new Date().toISOString().slice(11, 19) + ' UTC',
    },
  ]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const onNotifyRef = useRef(onNotify);
  const onConfigUpdatedRef = useRef(onConfigUpdated);
  const sessionRef = useRef(session);
  onNotifyRef.current = onNotify;
  onConfigUpdatedRef.current = onConfigUpdated;
  sessionRef.current = session;

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.getAiConfig(sessionRef.current);
      setConfig(res.config);
      setProvider(res.config.provider);
      setGoogleModel(res.config.googleModel);
      setLmStudioBaseUrl(res.config.lmStudioBaseUrl);
      setLmStudioModel(res.config.lmStudioModel);
      setTemperature(res.config.temperature);
      onConfigUpdatedRef.current?.(res.config);
    } catch (err) {
      onNotifyRef.current(err instanceof Error ? err.message : 'Failed to load AI config', 'err');
    }
  }, [session.tenantId]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [thread, sending]);

  const handleSaveConfig = async (overrides?: {
    clearGoogleApiKey?: boolean;
    clearLmStudioApiKey?: boolean;
  }) => {
    setSavingConfig(true);
    try {
      const res = await api.saveAiConfig(session, {
        provider,
        googleModel: googleModel.trim() || 'gemini-2.5-flash',
        lmStudioBaseUrl: lmStudioBaseUrl.trim() || 'http://localhost:1234/v1',
        lmStudioModel: lmStudioModel.trim(),
        temperature,
        ...(googleApiKey.trim() ? { googleApiKey: googleApiKey.trim() } : {}),
        ...(lmStudioApiKey.trim() ? { lmStudioApiKey: lmStudioApiKey.trim() } : {}),
        ...overrides,
      });
      setConfig(res.config);
      setGoogleApiKey('');
      setLmStudioApiKey('');
      onConfigUpdated?.(res.config);
      onNotify(
        `Saved ${provider === 'google_ai_studio' ? 'Google AI Studio (Gemini)' : 'LM Studio'} config (AES-256-GCM vault)`,
        'ok'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save AI configuration', 'err');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleFetchLmModels = async () => {
    setLoadingModels(true);
    try {
      const res = await api.listLmStudioModels(session, {
        baseUrl: lmStudioBaseUrl,
        apiKey: lmStudioApiKey || undefined,
      });
      setLmModels(res.models);
      if (res.models.length === 0) {
        onNotify('Connected to LM Studio, but no models are currently loaded in Developer Server.', 'info');
      } else {
        if (!lmStudioModel && res.models[0]) setLmStudioModel(res.models[0].id);
        onNotify(`Discovered ${res.models.length} loaded LM Studio model(s)`, 'ok');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Could not reach LM Studio server', 'err');
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setTestResult(null);
    try {
      const res = await api.testAiConnection(session, {
        provider,
        googleApiKey: googleApiKey.trim() || undefined,
        googleModel: googleModel.trim() || undefined,
        lmStudioBaseUrl: lmStudioBaseUrl.trim() || undefined,
        lmStudioModel: lmStudioModel.trim() || undefined,
        lmStudioApiKey: lmStudioApiKey.trim() || undefined,
      });
      setTestResult(res.result);
      if (res.result.ok) {
        onNotify(`Connected to ${res.result.model} in ${res.result.latencyMs}ms`, 'ok');
      } else {
        onNotify(res.result.error ?? 'Connection test failed', 'err');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection test failed';
      setTestResult({ ok: false, model: '', latencyMs: 0, error: msg });
      onNotify(msg, 'err');
    } finally {
      setTestingConn(false);
    }
  };

  const handleSend = async (promptOverride?: string) => {
    const text = (promptOverride ?? inputText).trim();
    if (!text || sending) return;

    const userEntry: ChatThreadEntry = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString().slice(11, 19) + ' UTC',
    };
    const nextThread = [...thread, userEntry];
    setThread(nextThread);
    if (!promptOverride) setInputText('');
    setSending(true);

    try {
      if (
        (googleApiKey.trim() && provider === 'google_ai_studio') ||
        (lmStudioApiKey.trim() && provider === 'lm_studio')
      ) {
        await handleSaveConfig();
      }

      const history: AiChatMessage[] = nextThread
        .filter((m) => m.id !== 'welcome' && !m.isError)
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await api.chatAiAgent(session, {
        messages: history,
        providerOverride: provider,
        modelOverride:
          provider === 'google_ai_studio'
            ? googleModel.trim() || undefined
            : lmStudioModel.trim() || undefined,
        autoExecute,
      });

      setThread((prev) => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          role: 'assistant',
          content: res.response.reply,
          provider: res.response.provider,
          model: res.response.model,
          latencyMs: res.response.latencyMs,
          usage: res.response.usage,
          actions: res.response.actions,
          timestamp: new Date().toISOString().slice(11, 19) + ' UTC',
        },
      ]);

      const okActions = res.response.actions.filter((a) => a.status === 'succeeded').length;
      if (okActions > 0) {
        onNotify(`AI Agent executed ${okActions} live SagaFlow action(s)`, 'ok');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI Agent request failed';
      setThread((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: msg,
          isError: true,
          timestamp: new Date().toISOString().slice(11, 19) + ' UTC',
        },
      ]);
      onNotify(msg, 'err');
    } finally {
      setSending(false);
    }
  };

  const activeModelLabel =
    provider === 'google_ai_studio'
      ? googleModel || 'gemini-2.5-flash'
      : lmStudioModel || 'auto-model';

  const tempTag =
    temperature <= 0.25
      ? '(Deterministic)'
      : temperature <= 0.65
        ? '(Balanced)'
        : '(Creative)';

  return (
    <div className="sf-surface-bg flex h-full w-full overflow-hidden">
      {/* LEFT PROVIDER CONFIGURATION SIDEBAR */}
      <aside className="flex w-[335px] shrink-0 flex-col border-r border-[#1c2227] bg-[#111417]">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[9.5px] font-bold tracking-[0.12em] text-zinc-400">
                MODEL PROVIDERS
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                Encrypted vault targeting live DAG engine
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 font-mono text-[9px]">
              <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-1.5 py-0.5 font-bold text-[#22e55c]">
                ZERO MOCKS
              </span>
              <span className="text-zinc-500">AES-256-GCM</span>
            </div>
          </div>

          {/* 2 Top-Stripe Provider Selector Cards */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="provider-lmstudio"
              onClick={() => setProvider('lm_studio')}
              className={`rounded-md border p-2.5 text-left transition ${
                provider === 'lm_studio'
                  ? 'sf-top-neon border-[#22e55c]/45 bg-[#111813]'
                  : 'border-[#262c32] bg-[#15191d] hover:border-[#2f373f]'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-white">
                  <Cpu
                    className={`h-3.5 w-3.5 ${
                      provider === 'lm_studio' ? 'text-[#22e55c]' : 'text-zinc-400'
                    }`}
                  />
                  LM Studio
                </span>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[8.5px] font-bold ${
                    provider === 'lm_studio'
                      ? 'bg-[#22e55c] text-[#070b07]'
                      : 'border border-[#2f373f] bg-[#0c0e10] text-zinc-400'
                  }`}
                >
                  {provider === 'lm_studio' ? 'ACTIVE' : 'LOCAL'}
                </span>
              </div>
              <div className="mt-2 font-mono text-[10px] leading-snug text-zinc-400">
                OpenAI API $0/mo
                <br />
                localhost:1234/v1
              </div>
            </button>

            <button
              type="button"
              data-testid="provider-google"
              onClick={() => setProvider('google_ai_studio')}
              className={`rounded-md border p-2.5 text-left transition ${
                provider === 'google_ai_studio'
                  ? 'sf-top-neon border-[#22e55c]/45 bg-[#111813]'
                  : 'border-[#262c32] bg-[#15191d] hover:border-[#2f373f]'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-white">
                  <Sparkles
                    className={`h-3.5 w-3.5 ${
                      provider === 'google_ai_studio' ? 'text-[#22e55c]' : 'text-zinc-400'
                    }`}
                  />
                  Google AI
                </span>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[8.5px] font-bold ${
                    provider === 'google_ai_studio'
                      ? 'bg-[#22e55c] text-[#070b07]'
                      : 'border border-[#2f373f] bg-[#0c0e10] text-zinc-400'
                  }`}
                >
                  {provider === 'google_ai_studio' ? 'ACTIVE' : 'KEY'}
                </span>
              </div>
              <div className="mt-2 font-mono text-[10px] leading-snug text-zinc-400">
                Gemini 2.5 Flash / Pro
                <div className="mt-0.5 text-[#22e55c]">
                  ● {config?.hasGoogleApiKey ? 'Encrypted Vault' : 'API Key Ready'}
                </div>
              </div>
            </button>
          </div>

          {/* Dynamic Provider Configuration Card */}
          <div className="sf-card space-y-3 rounded-md p-3">
            {provider === 'lm_studio' ? (
              <>
                <div>
                  <label className="block font-mono text-[10px] tracking-wider text-zinc-400">
                    LM_STUDIO_BASE_URL
                  </label>
                  <input
                    value={lmStudioBaseUrl}
                    onChange={(e) => setLmStudioBaseUrl(e.target.value)}
                    placeholder="http://localhost:1234/v1"
                    className="mt-1 w-full rounded border border-[#262c32] bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-[#22e55c]/60 focus:outline-none"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="font-mono text-[10px] tracking-wider text-zinc-400">
                      LOADED MODEL ID
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleFetchLmModels()}
                      disabled={loadingModels}
                      className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-[#22e55c] hover:underline disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${loadingModels ? 'animate-spin' : ''}`} />
                      Discover Models
                    </button>
                  </div>
                  <input
                    value={lmStudioModel}
                    onChange={(e) => setLmStudioModel(e.target.value)}
                    placeholder="auto-detect first loaded model"
                    className="mt-1 w-full rounded border border-[#262c32] bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-[#22e55c]/60 focus:outline-none"
                  />
                  {lmModels.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {lmModels.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setLmStudioModel(m.id)}
                          className={`rounded border px-2 py-0.5 font-mono text-[10px] transition ${
                            lmStudioModel === m.id
                              ? 'border-[#22e55c]/60 bg-[#22e55c]/14 text-[#22e55c]'
                              : 'border-[#262c32] bg-[#111417] text-zinc-300 hover:border-zinc-500'
                          }`}
                        >
                          {m.id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <label className="font-mono text-[10px] tracking-wider text-zinc-400">
                      OPTIONAL BEARER KEY
                    </label>
                    {config?.hasLmStudioApiKey && (
                      <button
                        type="button"
                        onClick={() => void handleSaveConfig({ clearLmStudioApiKey: true })}
                        className="font-mono text-[10px] text-rose-400 hover:underline"
                      >
                        CLEAR
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={lmStudioApiKey}
                    onChange={(e) => setLmStudioApiKey(e.target.value)}
                    placeholder={
                      config?.hasLmStudioApiKey
                        ? '•••••••• (encrypted in vault)'
                        : 'Optional for remote LM Studio'
                    }
                    className="mt-1 w-full rounded border border-[#262c32] bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-[#22e55c]/60 focus:outline-none"
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1 font-mono text-[10px] tracking-wider text-zinc-400">
                      <KeyRound className="h-3 w-3 text-[#22e55c]" />
                      GEMINI_API_KEY
                    </label>
                    {config?.hasGoogleApiKey && (
                      <button
                        type="button"
                        onClick={() => void handleSaveConfig({ clearGoogleApiKey: true })}
                        className="font-mono text-[10px] text-zinc-400 hover:text-rose-400"
                      >
                        CLEAR
                      </button>
                    )}
                  </div>
                  <div className="relative mt-1">
                    <input
                      type="password"
                      value={googleApiKey}
                      onChange={(e) => setGoogleApiKey(e.target.value)}
                      placeholder={
                        config?.hasGoogleApiKey
                          ? '••••••••••••••••••••••••'
                          : 'Paste AIzaSy... Google AI Studio key'
                      }
                      className="w-full rounded border border-[#262c32] bg-[#0c0e10] py-1.5 pl-2.5 pr-20 font-mono text-xs text-zinc-100 focus:border-[#22e55c]/60 focus:outline-none"
                    />
                    {config?.hasGoogleApiKey && !googleApiKey && (
                      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-[#22e55c]/40 bg-[#22e55c]/14 px-1.5 py-0.5 font-mono text-[9px] font-bold text-[#22e55c]">
                        ENCRYPTED
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block font-mono text-[10px] tracking-wider text-zinc-400">
                    MODEL VARIANT
                  </label>
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                    {GEMINI_MODELS.map((m) => {
                      const active = googleModel === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setGoogleModel(m.id)}
                          className={`flex items-center justify-between rounded border px-2 py-1.5 font-mono text-[10.5px] transition ${
                            active
                              ? 'border-[#22e55c]/55 bg-[#22e55c]/12 text-[#22e55c]'
                              : 'border-[#262c32] bg-[#0c0e10] text-zinc-300 hover:border-[#2f373f]'
                          }`}
                        >
                          <span className="truncate">{m.id}</span>
                          {active ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#22e55c]" />
                          ) : (
                            <span className="text-[9px] text-zinc-500">{m.badge}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    value={googleModel}
                    onChange={(e) => setGoogleModel(e.target.value)}
                    placeholder="Custom Gemini model ID"
                    className="mt-1.5 w-full rounded border border-[#262c32] bg-[#0c0e10] px-2.5 py-1 font-mono text-[11px] text-zinc-200 focus:border-[#22e55c]/60 focus:outline-none"
                  />
                </div>
              </>
            )}

            {/* Sampling Temperature Slider */}
            <div className="pt-1">
              <div className="flex items-center justify-between font-mono text-[10px]">
                <span className="tracking-wider text-zinc-400">SAMPLING TEMPERATURE</span>
                <span className="font-semibold text-[#22e55c]">
                  {temperature.toFixed(2)} {tempTag}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className="mt-1.5 w-full accent-[#22e55c]"
              />
              <div className="flex justify-between font-mono text-[9px] text-zinc-500">
                <span>0.0 STRICT REPEATABLE</span>
                <span>1.0 CREATIVE</span>
              </div>
            </div>

            {/* Save + Test Ping Action Row */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={savingConfig}
                onClick={() => void handleSaveConfig()}
                className="sf-btn-neon flex flex-1 items-center justify-center gap-1.5 rounded py-2 font-mono text-[11px] disabled:opacity-50"
              >
                {savingConfig ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Save Config
              </button>
              <button
                type="button"
                disabled={testingConn}
                onClick={() => void handleTestConnection()}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-[#2f373f] bg-[#15191d] px-3 py-2 font-mono text-[11px] font-medium text-zinc-200 transition hover:border-[#22e55c]/45 hover:text-[#22e55c] disabled:opacity-50"
              >
                {testingConn ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#22e55c]" />
                ) : (
                  <Zap className="h-3.5 w-3.5 text-[#22e55c]" />
                )}
                Test Ping
              </button>
            </div>

            {testResult && (
              <div
                className={`rounded border px-2.5 py-2 font-mono text-[10.5px] ${
                  testResult.ok
                    ? 'border-[#22e55c]/40 bg-[#22e55c]/10 text-[#73ff86]'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold">
                  {testResult.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#22e55c]" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                  )}
                  {testResult.ok
                    ? `${testResult.latencyMs}ms Latency · ${testResult.model} Ready`
                    : 'Provider unreachable'}
                </div>
                {testResult.error && (
                  <div className="mt-1 break-words text-[10px] opacity-90">{testResult.error}</div>
                )}
              </div>
            )}
          </div>

          {/* Auto-Execute Real Tools Toggle */}
          <div className="sf-card rounded-md p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Wrench className="h-3.5 w-3.5 text-[#22e55c]" />
                Auto-Execute Real Tools
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoExecute}
                onClick={() => setAutoExecute((v) => !v)}
                className={`relative h-5 w-9 shrink-0 rounded border transition ${
                  autoExecute
                    ? 'border-[#22e55c] bg-[#22e55c]'
                    : 'border-[#262c32] bg-[#111417]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-[2px] transition-all ${
                    autoExecute ? 'left-4.5 bg-[#070b07]' : 'left-0.5 bg-[#808d99]'
                  }`}
                />
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-zinc-400">
              Permits autonomous workflow synthesis, live Saga runs, DB mutations, and approval
              decisions directly against tenant storage.
            </p>
          </div>

          {/* Directive Starters */}
          <div className="space-y-1.5">
            <div className="font-mono text-[9.5px] font-bold tracking-[0.12em] text-zinc-500">
              DIRECTIVE STARTERS
            </div>
            {STARTER_TASKS.map((task) => (
              <button
                key={task.label}
                type="button"
                disabled={sending}
                onClick={() => void handleSend(task.prompt)}
                className={`flex w-full items-center justify-between gap-2 rounded border px-2.5 py-2 text-left text-[11px] font-medium transition disabled:opacity-40 ${
                  task.tone === 'danger'
                    ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-300 hover:border-rose-400/50'
                    : 'border-[#262c32] bg-[#15191d] text-zinc-200 hover:border-[#22e55c]/45 hover:text-white'
                }`}
              >
                <span className="truncate">{task.label}</span>
                <ArrowRight className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            ))}
          </div>
        </div>

        {/* Bottom Runtime Status Bar */}
        <div className="flex shrink-0 items-center justify-between border-t border-[#1c2227] bg-[#0c0e10] px-3.5 py-2 font-mono text-[10px]">
          <span className="inline-flex items-center gap-1.5 text-zinc-300">
            <span className="h-1.5 w-1.5 rounded-full bg-[#22e55c]" />
            Agent Runtime Ready
          </span>
          <span className="text-zinc-500">ZERO-MOCK v4.0</span>
        </div>
      </aside>

      {/* RIGHT AUTONOMOUS CHAT & VISUAL TOOL EXECUTION WORKSPACE */}
      <section className="flex min-w-0 flex-1 flex-col bg-[#0c0e10]">
        {/* Top Session Status Pill Bar */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#1c2227] bg-[#111417] px-5 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-[#22e55c]">
              <CheckCircle2 className="h-3 w-3" />
              SESSION INITIALIZED WITH ZERO-MOCK RUNTIME · TOOLS WIRED TO DAG ENGINE
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[10.5px] text-zinc-400 md:inline">
              {provider === 'google_ai_studio' ? 'Google AI' : 'LM Studio'} ·{' '}
              <strong className="text-[#22e55c]">{activeModelLabel}</strong>
            </span>
            <button
              type="button"
              onClick={() => setThread((prev) => prev.slice(0, 1))}
              className="inline-flex items-center gap-1 rounded border border-[#262c32] bg-[#15191d] px-2.5 py-1 font-mono text-[10.5px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-100"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          </div>
        </div>

        {/* Message Stream */}
        <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-4xl space-y-5">
            {thread.map((msg) => {
              const isUser = msg.role === 'user';
              return (
                <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                  {/* Sender Header */}
                  <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                    {!isUser && <Bot className="h-3.5 w-3.5 text-[#22e55c]" />}
                    <span className={isUser ? 'text-zinc-400' : 'font-semibold text-[#22e55c]'}>
                      {isUser
                        ? session.userId
                        : `SagaFlow Agent (${msg.model ?? activeModelLabel})`}
                    </span>
                    <span>·</span>
                    <span>{msg.timestamp}</span>
                  </div>

                  {/* Bubble */}
                  <div
                    className={`w-full max-w-3xl rounded-md border px-4 py-3.5 text-[13px] leading-relaxed ${
                      isUser
                        ? 'max-w-2xl border-[#262c32] bg-[#15191d] text-zinc-100'
                        : msg.isError
                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                          : 'border-[#262c32] bg-[#111417] text-zinc-200'
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{msg.content}</div>

                    {/* RICH TOOL EXECUTION CARDS */}
                    {msg.actions && msg.actions.length > 0 && (
                      <div className="mt-4 space-y-3">
                        {msg.actions.map((act, idx) => {
                          const data = (act.data ?? {}) as Record<string, unknown>;
                          const previewNodes = Array.isArray(data.nodes)
                            ? (data.nodes as PreviewNode[])
                            : [];
                          const compensators = previewNodes
                            .map((n) => n.compensationHandler)
                            .filter(Boolean) as string[];

                          return (
                            <div
                              key={`${msg.id}_act_${idx}`}
                              className="overflow-hidden rounded-md border border-[#262c32] bg-[#0c0e10]"
                            >
                              {/* Tool Header */}
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1c2227] bg-[#111417] px-3 py-2 font-mono text-[11px]">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-white">{act.tool}</span>
                                  <span
                                    className={`rounded px-1.5 py-0.2 text-[9.5px] font-bold uppercase ${
                                      act.status === 'succeeded'
                                        ? 'bg-[#22e55c] text-[#070b07]'
                                        : act.status === 'failed'
                                          ? 'bg-rose-500 text-white'
                                          : 'bg-zinc-700 text-zinc-200'
                                    }`}
                                  >
                                    {act.status}
                                  </span>
                                </div>
                                {act.status === 'succeeded' && (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-[#22e55c]" />
                                )}
                              </div>

                              <div className="p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="text-xs font-semibold text-zinc-100">
                                    {act.summary}
                                  </div>
                                  {previewNodes.length > 0 && (
                                    <span className="font-mono text-[10px] text-zinc-400">
                                      {previewNodes.length} Nodes · {compensators.length} Compensators
                                    </span>
                                  )}
                                </div>

                                {/* Compensator Badges */}
                                {compensators.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {compensators.map((c, ci) => (
                                      <span
                                        key={ci}
                                        className="inline-flex items-center gap-1 rounded border border-violet-500/35 bg-violet-500/12 px-2 py-0.5 font-mono text-[10px] text-violet-300"
                                      >
                                        <RotateCcw className="h-2.5 w-2.5" />
                                        {c}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {/* Visual Horizontal Mini-DAG Pipeline Strip for create_workflow */}
                                {previewNodes.length > 0 && (
                                  <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded border border-[#1c2227] bg-[#0c0e10] p-2.5">
                                    {previewNodes.map((n, ni) => (
                                      <React.Fragment key={n.id}>
                                        <div
                                          className={`rounded border px-2.5 py-1.5 ${
                                            n.type === 'approval'
                                              ? 'border-amber-400/50 bg-amber-500/15'
                                              : n.type === 'ai_agent'
                                                ? 'border-[#22e55c]/50 bg-[#22e55c]/10'
                                                : 'border-[#262c32] bg-[#15191d]'
                                          }`}
                                        >
                                          <div
                                            className={`font-mono text-[8.5px] font-bold uppercase tracking-wider ${
                                              n.type === 'approval'
                                                ? 'text-amber-300'
                                                : n.type === 'ai_agent'
                                                  ? 'text-[#22e55c]'
                                                  : 'text-zinc-500'
                                            }`}
                                          >
                                            {n.type.replace('_', ' ')}
                                          </div>
                                          <div className="max-w-[130px] truncate text-[11px] font-medium text-white">
                                            {n.label}
                                          </div>
                                        </div>
                                        {ni < previewNodes.length - 1 && (
                                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                                        )}
                                      </React.Fragment>
                                    ))}
                                  </div>
                                )}

                                {/* 3-Column Run Telemetry Strip for run_workflow */}
                                {act.runId && (
                                  <div className="mt-2.5 grid grid-cols-2 gap-2 rounded border border-[#1c2227] bg-[#0c0e10] p-2.5 font-mono text-[10.5px] sm:grid-cols-3">
                                    <div>
                                      <div className="text-[9px] text-zinc-500">RUN ID</div>
                                      <div className="mt-0.5 truncate text-[#22e55c]">{act.runId}</div>
                                    </div>
                                    <div>
                                      <div className="text-[9px] text-zinc-500">WORKFLOW</div>
                                      <div className="mt-0.5 truncate text-zinc-200">
                                        {act.workflowId ?? 'Published Saga'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[9px] text-zinc-500">DISPATCH</div>
                                      <div className="mt-0.5 text-zinc-200">Durable Queue</div>
                                    </div>
                                  </div>
                                )}

                                {/* Action Deep-Link Buttons */}
                                {(act.workflowId || act.runId) && (
                                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                                    {act.workflowId && (
                                      <button
                                        type="button"
                                        onClick={() => onOpenWorkflow(act.workflowId!)}
                                        className="inline-flex items-center gap-1.5 rounded border border-[#2f373f] bg-[#15191d] px-3 py-1.5 font-mono text-[10.5px] font-semibold text-zinc-100 transition hover:border-[#22e55c]/50 hover:text-[#22e55c]"
                                      >
                                        OPEN IN STUDIO
                                        <ExternalLink className="h-3 w-3" />
                                      </button>
                                    )}
                                    {act.runId && (
                                      <button
                                        type="button"
                                        onClick={() => onInspectRun(act.runId!)}
                                        className="sf-btn-neon inline-flex items-center gap-1.5 rounded px-3.5 py-1.5 font-mono text-[10.5px]"
                                      >
                                        INSPECT LIVE RUN
                                        <ExternalLink className="h-3 w-3" />
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Latency & Token Metadata Footer */}
                    {msg.latencyMs !== undefined && (
                      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[#1c2227] pt-2 font-mono text-[10px] text-zinc-500">
                        <span className="text-[#22e55c]">{msg.model}</span>
                        <span>{msg.latencyMs}ms</span>
                        {msg.usage?.totalTokens && <span>{msg.usage.totalTokens} tokens</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {sending && (
              <div className="flex items-center gap-2.5 rounded-md border border-[#22e55c]/35 bg-[#111813] px-4 py-3 font-mono text-xs text-[#73ff86]">
                <Loader2 className="h-4 w-4 animate-spin text-[#22e55c]" />
                <span>
                  Querying {provider === 'google_ai_studio' ? 'Google AI Studio' : 'LM Studio'} (
                  {activeModelLabel}) & executing live SagaFlow tools...
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Bottom Industrial Prompt Composer */}
        <div className="shrink-0 border-t border-[#1c2227] bg-[#111417] px-6 py-3.5">
          <div className="mx-auto max-w-4xl">
            <div className="overflow-hidden rounded-md border border-[#262c32] bg-[#111417] focus-within:border-[#22e55c]/60">
              <textarea
                rows={2}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Instruct the SagaFlow AI Agent to synthesize DAGs, run Sagas, query DB state, or heal DLQ..."
                className="w-full resize-none bg-transparent px-4 py-3 font-mono text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
              />
              <div className="flex items-center justify-between border-t border-[#1c2227] bg-[#111417] px-3 py-2">
                <div className="flex items-center gap-2.5 font-mono text-[10px]">
                  <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2 py-0.5 font-bold text-[#22e55c]">
                    7 TOOLS LOADED
                  </span>
                  <span className="hidden text-zinc-500 sm:inline">
                    Shift+Enter for newline · Grounded in live tenant DB
                  </span>
                </div>
                <button
                  type="button"
                  disabled={sending || !inputText.trim()}
                  onClick={() => void handleSend()}
                  className="sf-btn-neon inline-flex items-center gap-1.5 rounded px-4 py-1.5 font-mono text-xs disabled:opacity-40"
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <span>Automate</span>
                      <CornerDownLeft className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
