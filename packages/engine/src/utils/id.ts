import { createHash, randomBytes } from 'node:crypto';

export function makeId(prefix: string): string {
  const rand = randomBytes(8).toString('hex');
  return `${prefix}_${rand}`;
}

export function generateApiKey(): { rawKey: string; prefix: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  const rawKey = `sf_live_${secret}`;
  const prefix = rawKey.slice(0, 14);
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
