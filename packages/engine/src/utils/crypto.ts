import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * AES-256-GCM Secret Vault Cipher.
 * Derives a 256-bit key from SAGAFLOW_MASTER_KEY or a local auto-generated keyfile
 * stored in `<storagePath>/.master.key` (0600) — $0 budget, zero external KMS needed.
 */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(options: { masterKey?: string; storagePath?: string } = {}) {
    const secretSource = this.resolveMasterSecret(options);
    this.key = scryptSync(secretSource, 'sagaflow-vault-v1', 32);
  }

  private resolveMasterSecret(options: { masterKey?: string; storagePath?: string }): string {
    if (options.masterKey && options.masterKey.trim().length >= 12) {
      return options.masterKey.trim();
    }
    if (process.env.SAGAFLOW_MASTER_KEY && process.env.SAGAFLOW_MASTER_KEY.trim().length >= 12) {
      return process.env.SAGAFLOW_MASTER_KEY.trim();
    }
    if (!options.storagePath || options.storagePath === ':memory:') {
      return randomBytes(32).toString('hex');
    }
    const dir = resolve(options.storagePath);
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, '.master.key');
    if (existsSync(keyFile)) {
      return readFileSync(keyFile, 'utf8').trim();
    }
    const generated = randomBytes(32).toString('hex');
    writeFileSync(keyFile, generated, { mode: 0o600 });
    return generated;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Malformed encrypted secret payload');
    }
    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const ciphertext = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  getSigningSecret(): Buffer {
    return this.key;
  }
}

/**
 * Password hashing using Node.js native scrypt with per-password random 16-byte salt.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Zero-dependency HS256 JWT implementation using Node.js native HMAC-SHA256.
 */
export interface JwtClaims {
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signJwt(
  claims: Omit<JwtClaims, 'iat' | 'exp'>,
  signingKey: Buffer | string,
  ttlSeconds = 60 * 60 * 24 * 7
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: JwtClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(fullClaims));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', signingKey).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token: string, signingKey: Buffer | string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expectedSig = createHmac('sha256', signingKey).update(`${header}.${payload}`).digest();
  const actualSig = Buffer.from(sig, 'base64url');
  if (expectedSig.length !== actualSig.length) return null;
  if (!timingSafeEqual(expectedSig, actualSig)) return null;

  try {
    const claims = JSON.parse(b64urlDecode(payload)) as JwtClaims;
    if (!claims.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Inbound Webhook HMAC-SHA256 signature calculation & constant-time verification.
 * Accepts header format `sha256=<hex>` or raw `<hex>`.
 */
export function computeWebhookHmac(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

export function verifyWebhookHmac(secret: string, rawBody: string, headerValue: string): boolean {
  const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const providedHex = headerValue.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(providedHex, 'hex'));
}
