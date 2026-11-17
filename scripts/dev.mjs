#!/usr/bin/env node
/**
 * Zero-dependency development runner: starts the Hono API (:4000) and the
 * Vite Studio (:5173, proxying /api to :4000) together with one command.
 *
 * Usage: npm run dev
 */
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
// When launched via `npm run dev`, npm_execpath points at npm-cli.js. Spawning
// Node directly avoids a shell and the associated argument-escaping warning.
const npmCli = process.env.npm_execpath;
const spawnCommand = npmCli ? process.execPath : npmCmd;
const useShell = !npmCli && isWindows;

const children = [];
let shuttingDown = false;

function start(name, color, args) {
  const spawnArgs = npmCli ? [npmCli, ...args] : args;
  const child = spawn(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`\n[dev] ${name} exited with code ${code ?? 0}. Stopping the other process...`);
    shutdown(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`[dev] Failed to start ${name}:`, err);
    shutdown(1);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill(isWindows ? undefined : 'SIGINT');
      } catch {
        /* already gone */
      }
    }
  }
  // Give children a moment to close their SQLite handles cleanly.
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] SagaFlow API  -> http://localhost:4000');
console.log('[dev] SagaFlow Studio -> http://localhost:5173');
start('api', 'green', ['run', 'dev:api']);
start('web', 'cyan', ['run', 'dev:web']);
