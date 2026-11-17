export interface TemplateContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  secrets: Record<string, string>;
  env: {
    runId: string;
    tenantId: string;
  };
}

function lookupPath(root: Record<string, unknown>, pathExpr: string): unknown {
  const segments = pathExpr.split('.').map((s) => s.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const FULL_EXPRESSION_RE = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;
const INLINE_EXPRESSION_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Recursively resolves `{{input.*}}`, `{{steps.<nodeId>.*}}`, `{{secrets.<NAME>}}`, and `{{env.*}}`
 * placeholders across strings, arrays, and objects.
 * Preserves native JSON types when a string is solely a single `{{...}}` expression.
 */
export function resolveTemplates<T>(value: T, ctx: TemplateContext): T {
  const root: Record<string, unknown> = {
    input: ctx.input,
    steps: ctx.steps,
    secrets: ctx.secrets,
    env: ctx.env,
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const fullMatch = node.match(FULL_EXPRESSION_RE);
      if (fullMatch) {
        const resolved = lookupPath(root, fullMatch[1]);
        return resolved !== undefined ? resolved : node;
      }
      if (!node.includes('{{')) return node;
      return node.replace(INLINE_EXPRESSION_RE, (raw, expr: string) => {
        const resolved = lookupPath(root, expr);
        if (resolved === undefined || resolved === null) return '';
        return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
      });
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}

/**
 * Recursively redacts decrypted secret values from persisted outputs, logs, and SSE payloads
 * so secrets can be used securely at runtime without ever leaking into logs or UI history.
 */
export function redactSecrets<T>(value: T, secretValues: string[]): T {
  const activeSecrets = secretValues.filter((s) => typeof s === 'string' && s.length >= 4);
  if (activeSecrets.length === 0) return value;

  const maskString = (str: string): string => {
    let out = str;
    for (const sec of activeSecrets) {
      if (out.includes(sec)) {
        out = out.split(sec).join('[REDACTED]');
      }
    }
    return out;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return maskString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}
