import { ApiError, type RbacRole, type Tenant } from '@sagaflow/shared';
import { hashApiKey, verifyJwt, type StorageAdapter } from '@sagaflow/engine';
import type { Context, Next } from 'hono';
import { ZodError } from 'zod';

export interface AuthContext {
  tenantId: string;
  tenant: Tenant;
  userId?: string;
  userEmail?: string;
  apiKeyId?: string;
  role: RbacRole;
  authMethod: 'api_key' | 'jwt' | 'dev_header';
}

export function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function extractBearerOrCookieToken(c: Context): {
  apiKey?: string;
  jwtToken?: string;
} {
  const isSse = c.req.path.endsWith('/stream');
  const explicitKey =
    c.req.header('x-api-key') ?? (isSse ? c.req.query('apiKey') : undefined);
  if (explicitKey) {
    return { apiKey: explicitKey };
  }

  const authHeader = c.req.header('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('sf_')) {
      return { apiKey: token };
    }
    if (token) {
      return { jwtToken: token };
    }
  }

  if (isSse) {
    const qToken = c.req.query('token');
    if (qToken) return { jwtToken: qToken };
  }

  const cookieToken = extractCookie(c.req.header('cookie'), 'sf_session');
  if (cookieToken) {
    return { jwtToken: cookieToken };
  }

  return {};
}

export class TenantRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  checkAndConsume(
    tenantId: string,
    limit: number
  ): { allowed: boolean; used: number; limit: number; resetAtSec: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(tenantId) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
      this.buckets.set(tenantId, timestamps);
      const oldest = timestamps[0] ?? now;
      return {
        allowed: false,
        used: timestamps.length,
        limit,
        resetAtSec: Math.ceil((oldest + this.windowMs) / 1000),
      };
    }

    timestamps.push(now);
    this.buckets.set(tenantId, timestamps);
    return {
      allowed: true,
      used: timestamps.length,
      limit,
      resetAtSec: Math.ceil((now + this.windowMs) / 1000),
    };
  }

  getUsed(tenantId: string): number {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.buckets.get(tenantId) ?? []).filter((t) => t > cutoff);
    this.buckets.set(tenantId, list);
    return list.length;
  }
}

export function formatZodError(err: ZodError): ApiError {
  return new ApiError(
    400,
    'invalid_request',
    'Request validation failed',
    err.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.join('.') || 'body',
      message: issue.message,
    }))
  );
}

export function createTenantAuthMiddleware(params: {
  storage: StorageAdapter;
  rateLimiter: TenantRateLimiter;
  authMode: 'dev' | 'prod';
  jwtSecret: string;
}) {
  const { storage, rateLimiter, authMode, jwtSecret } = params;

  return async (c: Context, next: Next) => {
    const { apiKey, jwtToken } = extractBearerOrCookieToken(c);
    const isSse = c.req.path.endsWith('/stream');

    let auth: AuthContext | null = null;

    if (apiKey) {
      const verified = await storage.verifyApiKeyHash(hashApiKey(apiKey));
      if (!verified) {
        throw new ApiError(401, 'unauthenticated', 'Invalid or revoked API key.');
      }
      const tenant = await storage.getTenant(verified.tenantId);
      if (!tenant) {
        throw new ApiError(401, 'unauthenticated', 'API key references an unknown tenant.');
      }
      auth = {
        tenantId: tenant.id,
        tenant,
        apiKeyId: verified.keyId,
        role: 'admin',
        authMethod: 'api_key',
      };
    } else if (jwtToken) {
      const payload = verifyJwt(jwtToken, jwtSecret);
      if (!payload) {
        throw new ApiError(401, 'unauthenticated', 'Invalid or expired session token.');
      }
      const requestedTenantId =
        c.req.header('x-tenant-id') ?? (isSse ? c.req.query('tenantId') : undefined);
      let tenant: Tenant | null = null;
      if (requestedTenantId) {
        tenant = await storage.getTenant(requestedTenantId);
        if (!tenant) {
          throw new ApiError(403, 'forbidden', `Unknown tenant "${requestedTenantId}".`);
        }
        const isMember = await storage.hasMembership(tenant.id, payload.sub);
        if (!isMember) {
          throw new ApiError(
            403,
            'forbidden',
            `User "${payload.email}" is not a verified member of tenant "${tenant.id}".`
          );
        }
      } else {
        const userTenants = await storage.listUserTenants(payload.sub);
        if (userTenants.length === 0) {
          throw new ApiError(403, 'forbidden', 'User has no tenant memberships.');
        }
        tenant = userTenants[0];
      }
      const resolvedRole = (await storage.getMembershipRole(tenant.id, payload.sub)) ?? 'viewer';
      auth = {
        tenantId: tenant.id,
        tenant,
        userId: payload.sub,
        userEmail: payload.email,
        role: resolvedRole,
        authMethod: 'jwt',
      };
    } else if (authMode === 'dev') {
      const tenantId =
        c.req.header('x-tenant-id') ?? (isSse ? c.req.query('tenantId') : undefined);
      const userId =
        c.req.header('x-user-id') ?? (isSse ? c.req.query('userId') : undefined);

      if (!tenantId || !userId) {
        throw new ApiError(
          401,
          'unauthenticated',
          'Provide X-Api-Key, Authorization Bearer JWT, or (in AUTH_MODE=dev) X-Tenant-Id and X-User-Id headers.'
        );
      }

      const tenant = await storage.getTenant(tenantId);
      if (!tenant) {
        throw new ApiError(403, 'forbidden', `Unknown tenant "${tenantId}".`);
      }

      const isMember = await storage.hasMembership(tenantId, userId);
      if (!isMember) {
        throw new ApiError(
          403,
          'forbidden',
          `User "${userId}" is not a verified member of tenant "${tenantId}".`
        );
      }

      const resolvedRole = (await storage.getMembershipRole(tenant.id, userId)) ?? 'admin';
      auth = {
        tenantId: tenant.id,
        tenant,
        userId,
        role: resolvedRole,
        authMethod: 'dev_header',
      };
    } else {
      throw new ApiError(
        401,
        'unauthenticated',
        'Missing authentication. Provide X-Api-Key or Authorization: Bearer <jwt>.'
      );
    }

    // Per-tenant sliding-window rate limiting
    const rl = rateLimiter.checkAndConsume(auth.tenantId, auth.tenant.rateLimitPerMin);
    c.header('X-RateLimit-Limit', String(rl.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rl.limit - rl.used)));
    c.header('X-RateLimit-Reset', String(rl.resetAtSec));

    if (!rl.allowed) {
      throw new ApiError(
        429,
        'rate_limit_exceeded',
        `Tenant "${auth.tenant.name}" exceeded rate limit (${rl.limit} req/min).`
      );
    }

    c.header('X-SagaFlow-Role', auth.role);
    c.set('auth', auth);

    // Enforce Tenant RBAC permissions on write/mutation endpoints
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const readSafePost =
        path.startsWith('/api/ai/diagnose-run/') ||
        path === '/api/audit/verify' ||
        path === '/api/workflows/validate' ||
        (path.startsWith('/api/workflows/') && path.endsWith('/dry-run'));

      if (!readSafePost) {
        const isAdminOnly =
          path.startsWith('/api/api-keys') ||
          path.startsWith('/api/secrets') ||
          path.startsWith('/api/rbac') ||
          (path === '/api/ai/config' && method === 'PUT');

        const isApprovalDecision =
          path.startsWith('/api/approvals/') && path.endsWith('/decision');

        if (isAdminOnly && auth.role !== 'admin') {
          throw new ApiError(
            403,
            'forbidden',
            `RBAC denied: role "${auth.role}" cannot perform "${method} ${path}". Requires role: admin.`
          );
        }

        if (isApprovalDecision && auth.role !== 'admin' && auth.role !== 'approver') {
          throw new ApiError(
            403,
            'forbidden',
            `RBAC denied: role "${auth.role}" cannot decide approval gates. Requires role: admin or approver.`
          );
        }

        if (
          !isAdminOnly &&
          !isApprovalDecision &&
          auth.role !== 'admin' &&
          auth.role !== 'operator'
        ) {
          throw new ApiError(
            403,
            'forbidden',
            `RBAC denied: role "${auth.role}" is not permitted to mutate "${method} ${path}". Requires role: admin or operator.`
          );
        }
      }
    }

    await next();
  };
}
