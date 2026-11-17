import type {
  AiProvider,
  AiProviderConfig,
  AiTestConnectionInput,
  SaveAiConfigInput,
} from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';
import type { SecretCipher } from '../utils/crypto.js';

export const AI_CONFIG_KV_KEY = '__sagaflow_ai_config';
export const GOOGLE_KEY_SECRET_NAME = '__SAGAFLOW_AI_GOOGLE_KEY';
export const LMSTUDIO_KEY_SECRET_NAME = '__SAGAFLOW_AI_LMSTUDIO_KEY';

export const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

interface StoredAiSettings {
  provider: AiProvider;
  googleModel: string;
  googleBaseUrl: string;
  lmStudioBaseUrl: string;
  lmStudioModel: string;
  temperature: number;
  maxTokens: number;
  updatedAt: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionResult {
  text: string;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function defaultSettings(): StoredAiSettings {
  const envGoogleKey = process.env.GOOGLE_AI_STUDIO_API_KEY ?? process.env.GEMINI_API_KEY;
  const envLmUrl = process.env.LM_STUDIO_BASE_URL;
  return {
    provider: envGoogleKey ? 'google_ai_studio' : 'lm_studio',
    googleModel: process.env.GOOGLE_AI_MODEL ?? DEFAULT_GOOGLE_MODEL,
    googleBaseUrl: normalizeBaseUrl(process.env.GOOGLE_AI_BASE_URL ?? DEFAULT_GOOGLE_BASE_URL),
    lmStudioBaseUrl: normalizeBaseUrl(envLmUrl ?? DEFAULT_LMSTUDIO_BASE_URL),
    lmStudioModel: process.env.LM_STUDIO_MODEL ?? '',
    temperature: 0.25,
    maxTokens: 2048,
    updatedAt: new Date().toISOString(),
  };
}

export async function getAiConfig(
  storage: StorageAdapter,
  tenantId: string
): Promise<AiProviderConfig> {
  const state = await storage.getTenantState(tenantId);
  const kvEntry = state.kv.find((k) => k.key === AI_CONFIG_KV_KEY);
  const base = defaultSettings();
  const stored = (kvEntry?.value && typeof kvEntry.value === 'object'
    ? kvEntry.value
    : {}) as Partial<StoredAiSettings>;

  const googleSecret = await storage.getSecretRecord(tenantId, GOOGLE_KEY_SECRET_NAME);
  const lmSecret = await storage.getSecretRecord(tenantId, LMSTUDIO_KEY_SECRET_NAME);
  const envGoogleKey = process.env.GOOGLE_AI_STUDIO_API_KEY ?? process.env.GEMINI_API_KEY;

  return {
    provider: stored.provider === 'google_ai_studio' || stored.provider === 'lm_studio'
      ? stored.provider
      : base.provider,
    googleModel: stored.googleModel || base.googleModel,
    googleBaseUrl: normalizeBaseUrl(stored.googleBaseUrl || base.googleBaseUrl),
    lmStudioBaseUrl: normalizeBaseUrl(stored.lmStudioBaseUrl || base.lmStudioBaseUrl),
    lmStudioModel: stored.lmStudioModel ?? base.lmStudioModel,
    temperature: typeof stored.temperature === 'number' ? stored.temperature : base.temperature,
    maxTokens: typeof stored.maxTokens === 'number' ? stored.maxTokens : base.maxTokens,
    hasGoogleApiKey: Boolean(googleSecret || envGoogleKey),
    hasLmStudioApiKey: Boolean(lmSecret || process.env.LM_STUDIO_API_KEY),
    updatedAt: stored.updatedAt ?? base.updatedAt,
  };
}

export async function saveAiConfig(
  storage: StorageAdapter,
  cipher: SecretCipher,
  tenantId: string,
  input: SaveAiConfigInput
): Promise<AiProviderConfig> {
  const current = await getAiConfig(storage, tenantId);
  const next: StoredAiSettings = {
    provider: input.provider,
    googleModel: input.googleModel?.trim() || current.googleModel || DEFAULT_GOOGLE_MODEL,
    googleBaseUrl: normalizeBaseUrl(
      input.googleBaseUrl?.trim() || current.googleBaseUrl || DEFAULT_GOOGLE_BASE_URL
    ),
    lmStudioBaseUrl: normalizeBaseUrl(
      input.lmStudioBaseUrl?.trim() || current.lmStudioBaseUrl || DEFAULT_LMSTUDIO_BASE_URL
    ),
    lmStudioModel:
      input.lmStudioModel !== undefined ? input.lmStudioModel.trim() : current.lmStudioModel,
    temperature: input.temperature ?? current.temperature,
    maxTokens: input.maxTokens ?? current.maxTokens,
    updatedAt: new Date().toISOString(),
  };

  await storage.setKv(tenantId, AI_CONFIG_KV_KEY, next);

  if (input.clearGoogleApiKey) {
    await storage.deleteSecret(tenantId, GOOGLE_KEY_SECRET_NAME);
  } else if (input.googleApiKey && input.googleApiKey.trim().length > 0) {
    await storage.upsertSecret(tenantId, {
      name: GOOGLE_KEY_SECRET_NAME,
      encryptedValue: cipher.encrypt(input.googleApiKey.trim()),
      description: 'Google AI Studio (Gemini) API Key (encrypted via AES-256-GCM)',
    });
  }

  if (input.clearLmStudioApiKey) {
    await storage.deleteSecret(tenantId, LMSTUDIO_KEY_SECRET_NAME);
  } else if (input.lmStudioApiKey && input.lmStudioApiKey.trim().length > 0) {
    await storage.upsertSecret(tenantId, {
      name: LMSTUDIO_KEY_SECRET_NAME,
      encryptedValue: cipher.encrypt(input.lmStudioApiKey.trim()),
      description: 'LM Studio Bearer API Key (encrypted via AES-256-GCM)',
    });
  }

  return getAiConfig(storage, tenantId);
}

export async function resolveAiCredentials(
  storage: StorageAdapter,
  cipher: SecretCipher,
  tenantId: string
): Promise<{
  config: AiProviderConfig;
  googleApiKey?: string;
  lmStudioApiKey?: string;
}> {
  const config = await getAiConfig(storage, tenantId);
  const gRec = await storage.getSecretRecord(tenantId, GOOGLE_KEY_SECRET_NAME);
  const lRec = await storage.getSecretRecord(tenantId, LMSTUDIO_KEY_SECRET_NAME);

  let googleApiKey = process.env.GOOGLE_AI_STUDIO_API_KEY ?? process.env.GEMINI_API_KEY;
  if (gRec) {
    try {
      googleApiKey = cipher.decrypt(gRec.encryptedValue);
    } catch {
      // ignore undecryptable legacy secret
    }
  }

  let lmStudioApiKey = process.env.LM_STUDIO_API_KEY;
  if (lRec) {
    try {
      lmStudioApiKey = cipher.decrypt(lRec.encryptedValue);
    } catch {
      // ignore
    }
  }

  return { config, googleApiKey, lmStudioApiKey };
}

export async function fetchLmStudioModels(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 8000
): Promise<{ models: Array<{ id: string; ownedBy?: string }>; latencyMs: number }> {
  const started = Date.now();
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`LM Studio returned HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string; owned_by?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const rawList = Array.isArray(body.data)
      ? body.data.map((m) => ({ id: String(m.id ?? ''), ownedBy: m.owned_by }))
      : Array.isArray(body.models)
      ? body.models.map((m) => ({ id: String(m.id ?? m.name ?? '') }))
      : [];

    return {
      models: rawList.filter((m) => m.id.length > 0),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Timed out connecting to LM Studio at ${url}. Ensure LM Studio Local Server is started.`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach LM Studio at ${url} (${msg}). Start LM Studio → Developer tab → Start Server.`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlmProvider(opts: {
  provider: AiProvider;
  googleApiKey?: string;
  googleModel?: string;
  googleBaseUrl?: string;
  lmStudioBaseUrl?: string;
  lmStudioModel?: string;
  lmStudioApiKey?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  expectJson?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LlmCompletionResult> {
  const started = Date.now();
  const temperature = opts.temperature ?? 0.25;
  const maxTokens = opts.maxTokens ?? 2048;
  const timeoutMs = opts.timeoutMs ?? 45000;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (opts.provider === 'google_ai_studio') {
      const apiKey = opts.googleApiKey?.trim();
      if (!apiKey) {
        throw new Error(
          'Google AI Studio API key is not configured. Add your Gemini API key in AI Agent → Provider Config (encrypted with AES-256-GCM).'
        );
      }
      const model = (opts.googleModel?.trim() || DEFAULT_GOOGLE_MODEL).replace(/^models\//, '');
      const base = normalizeBaseUrl(opts.googleBaseUrl || DEFAULT_GOOGLE_BASE_URL);
      const endpoint = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const systemParts = opts.messages
        .filter((m) => m.role === 'system')
        .map((m) => ({ text: m.content }));
      const contents = opts.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const payload: Record<string, unknown> = {
        contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(opts.expectJson ? { responseMimeType: 'application/json' } : {}),
        },
      };
      if (systemParts.length > 0) {
        payload.systemInstruction = { parts: systemParts };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const rawText = await res.text();
      if (!res.ok) {
        // Scrub key if echoed
        const safeErr = rawText.replaceAll(apiKey, '[REDACTED]').slice(0, 320);
        throw new Error(`Google AI Studio API error (HTTP ${res.status}): ${safeErr}`);
      }

      const json = JSON.parse(rawText) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      };

      const text =
        json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('')
          .trim() ?? '';

      if (!text) {
        throw new Error(
          `Google AI Studio returned an empty response (finishReason=${json.candidates?.[0]?.finishReason ?? 'unknown'}).`
        );
      }

      return {
        text,
        provider: 'google_ai_studio',
        model,
        latencyMs: Date.now() - started,
        usage: json.usageMetadata
          ? {
              promptTokens: json.usageMetadata.promptTokenCount,
              completionTokens: json.usageMetadata.candidatesTokenCount,
              totalTokens: json.usageMetadata.totalTokenCount,
            }
          : undefined,
      };
    }

    // LM Studio (OpenAI-compatible /v1/chat/completions)
    const base = normalizeBaseUrl(opts.lmStudioBaseUrl || DEFAULT_LMSTUDIO_BASE_URL);
    let model = opts.lmStudioModel?.trim() || '';
    if (!model) {
      // Auto-discover the first loaded model in LM Studio!
      try {
        const discovered = await fetchLmStudioModels(base, opts.lmStudioApiKey, 4000);
        model = discovered.models[0]?.id || 'local-model';
      } catch {
        model = 'local-model';
      }
    }

    const endpoint = `${base}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.lmStudioApiKey?.trim()) {
      headers.Authorization = `Bearer ${opts.lmStudioApiKey.trim()}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) {
      const safeErr = opts.lmStudioApiKey
        ? rawText.replaceAll(opts.lmStudioApiKey, '[REDACTED]')
        : rawText;
      throw new Error(`LM Studio API error (HTTP ${res.status}): ${safeErr.slice(0, 320)}`);
    }

    const json = JSON.parse(rawText) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new Error('LM Studio returned an empty completion.');
    }

    return {
      text,
      provider: 'lm_studio',
      model: json.model || model,
      latencyMs: Date.now() - started,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`AI provider request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
}

export async function testAiConnection(
  storage: StorageAdapter,
  cipher: SecretCipher,
  tenantId: string,
  override?: AiTestConnectionInput
): Promise<{
  ok: boolean;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}> {
  const creds = await resolveAiCredentials(storage, cipher, tenantId);
  const provider = override?.provider ?? creds.config.provider;
  const googleApiKey = override?.googleApiKey?.trim() || creds.googleApiKey;
  const googleModel = override?.googleModel?.trim() || creds.config.googleModel;
  const googleBaseUrl = override?.googleBaseUrl?.trim() || creds.config.googleBaseUrl;
  const lmStudioBaseUrl = override?.lmStudioBaseUrl?.trim() || creds.config.lmStudioBaseUrl;
  const lmStudioModel = override?.lmStudioModel?.trim() || creds.config.lmStudioModel;
  const lmStudioApiKey = override?.lmStudioApiKey?.trim() || creds.lmStudioApiKey;

  const started = Date.now();
  try {
    const res = await callLlmProvider({
      provider,
      googleApiKey,
      googleModel,
      googleBaseUrl,
      lmStudioBaseUrl,
      lmStudioModel,
      lmStudioApiKey,
      messages: [
        { role: 'system', content: 'You are SagaFlow AI connectivity check. Reply briefly.' },
        { role: 'user', content: 'Reply with: SagaFlow AI online.' },
      ],
      temperature: 0,
      maxTokens: 64,
      timeoutMs: 15000,
    });
    return {
      ok: true,
      provider: res.provider,
      model: res.model,
      latencyMs: res.latencyMs,
      reply: res.text,
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      model: provider === 'google_ai_studio' ? googleModel : lmStudioModel || 'local-model',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
