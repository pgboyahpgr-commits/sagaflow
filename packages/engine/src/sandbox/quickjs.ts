import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

export interface SandboxRunOptions {
  code: string;
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  /** Least-privilege secret map (already filtered to allowedSecrets by the orchestrator) */
  secrets?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  output?: unknown;
  logs: string[];
  durationMs: number;
  error?: string;
}

let cachedQuickJsPromise: Promise<QuickJSWASMModule> | null = null;

async function loadQuickJs(): Promise<QuickJSWASMModule> {
  if (!cachedQuickJsPromise) {
    cachedQuickJsPromise = getQuickJS();
  }
  return cachedQuickJsPromise;
}

/**
 * Executes untrusted user JavaScript inside an isolated QuickJS WebAssembly runtime.
 * - Sealed WASM linear memory (zero access to Node process, fs, require, fetch, host V8 heap)
 * - Hard memory limit (setMemoryLimit)
 * - Wall-clock interrupt handler (setInterruptHandler) to kill infinite loops cleanly
 * - Pure JSON data bridge (input, steps) + captured console logs
 */
export async function runInQuickJSSandbox(options: SandboxRunOptions): Promise<SandboxRunResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 1500, 50), 5000);
  const memoryLimitMb = Math.min(Math.max(options.memoryLimitMb ?? 16, 2), 64);
  const logs: string[] = [];

  const QuickJS = await loadQuickJs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitMb * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const vm = runtime.newContext();

  try {
    // Expose safe console.log / warn / error bridge (capped to prevent log bombs)
    const logFn = vm.newFunction('__sfLog', (...args) => {
      if (logs.length >= 50) return;
      const parts = args.map((handle) => {
        try {
          const dumped = vm.dump(handle);
          return typeof dumped === 'string' ? dumped : JSON.stringify(dumped);
        } catch {
          return '[unserializable]';
        }
      });
      const line = parts.join(' ').slice(0, 512);
      logs.push(line);
    });
    vm.setProp(vm.global, '__sfLog', logFn);
    logFn.dispose();

    // Pass input, steps, and allowed secrets strictly as serialized JSON strings so no host object references cross
    const payloadJson = JSON.stringify({
      input: options.input ?? {},
      steps: options.steps ?? {},
      secrets: options.secrets ?? {},
    });
    const payloadHandle = vm.newString(payloadJson);
    vm.setProp(vm.global, '__sfPayloadJson', payloadHandle);
    payloadHandle.dispose();

    // Wrap user script cleanly so both `return { ... }` bodies and expressions work
    const userCode = options.code.trim();
    const wrapped = `
      "use strict";
      const console = Object.freeze({
        log: (...a) => __sfLog(...a),
        info: (...a) => __sfLog(...a),
        warn: (...a) => __sfLog("[warn]", ...a),
        error: (...a) => __sfLog("[error]", ...a),
      });
      const __parsed = JSON.parse(__sfPayloadJson);
      const __userFn = function(input, steps, secrets) {
        ${userCode}
      };
      const __result = __userFn(__parsed.input, __parsed.steps, Object.freeze(__parsed.secrets || {}));
      JSON.stringify(__result === undefined ? null : __result);
    `;

    const evalResult = vm.evalCode(wrapped, 'user-script.js');

    if (evalResult.error) {
      const errVal = vm.dump(evalResult.error);
      evalResult.error.dispose();
      const rawMessage =
        typeof errVal === 'object' && errVal !== null && 'message' in errVal
          ? String((errVal as { message: unknown }).message)
          : String(errVal);
      const message = timedOut
        ? `Sandbox execution timed out after ${timeoutMs}ms (CPU interrupt triggered)`
        : rawMessage.includes('out of memory')
          ? `Sandbox exceeded memory limit (${memoryLimitMb} MB)`
          : rawMessage;
      return {
        ok: false,
        logs,
        durationMs: Date.now() - startedAt,
        error: message,
      };
    }

    const rawOut = vm.dump(evalResult.value);
    evalResult.value.dispose();

    let output: unknown = null;
    if (typeof rawOut === 'string' && rawOut.length > 0) {
      output = JSON.parse(rawOut);
    }

    return {
      ok: true,
      output,
      logs,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      logs,
      durationMs: Date.now() - startedAt,
      error: timedOut
        ? `Sandbox execution timed out after ${timeoutMs}ms`
        : msg,
    };
  } finally {
    try {
      vm.dispose();
    } catch {
      // ignore disposal race after OOM
    }
    try {
      runtime.dispose();
    } catch {
      // ignore disposal race after OOM
    }
  }
}
