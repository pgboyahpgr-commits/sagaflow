import React, { useState } from 'react';
import { X, Lock, Mail, User as UserIcon, Building2, ShieldCheck } from 'lucide-react';
import type { AuthUser, Tenant } from '@sagaflow/shared';
import { api } from '../lib/api';

interface AuthModalProps {
  onClose: () => void;
  onAuthenticated: (data: { user: AuthUser; token: string; tenants: Tenant[] }) => void;
}

export function AuthModal({ onClose, onAuthenticated }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('admin@sagaflow.local');
  const [password, setPassword] = useState('sagaflow123');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res =
        mode === 'login'
          ? await api.authLogin(email.trim(), password)
          : await api.authRegister({
              email: email.trim(),
              password,
              name: name.trim(),
              tenantName: tenantName.trim() || undefined,
            });
      onAuthenticated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="sf-modal sf-top-neon w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#262c32] bg-[#111417] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded border border-[#22e55c]/40 bg-[#22e55c]/10 text-[#22e55c]">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[#f1f5f9]">SagaFlow Self-Hosted Auth</h2>
              <p className="sf-label-sm text-[#808d99]">SCRYPT HASHES · HS256 JWT</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-[#f1f5f9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="grid grid-cols-2 border-b border-[#262c32] bg-[#111417] p-1">
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`rounded py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider transition ${
              mode === 'login'
                ? 'bg-[#22e55c] text-[#070b07]'
                : 'text-[#808d99] hover:text-[#f1f5f9]'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setEmail('');
              setPassword('');
              setError(null);
            }}
            className={`rounded py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider transition ${
              mode === 'register'
                ? 'bg-[#22e55c] text-[#070b07]'
                : 'text-[#808d99] hover:text-[#f1f5f9]'
            }`}
          >
            Create Account
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5 p-5">
          {mode === 'register' && (
            <>
              <div>
                <label className="sf-label-sm block text-[#808d99]">FULL NAME</label>
                <div className="relative mt-1.5">
                  <UserIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#808d99]" />
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    className="sf-input w-full py-2 pl-8 pr-3"
                  />
                </div>
              </div>
              <div>
                <label className="sf-label-sm block text-[#808d99]">
                  ISOLATED WORKSPACE / TENANT NAME
                </label>
                <div className="relative mt-1.5">
                  <Building2 className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#808d99]" />
                  <input
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    placeholder="Stark Labs (provisions dedicated tenant DB)"
                    className="sf-input w-full py-2 pl-8 pr-3"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="sf-label-sm block text-[#808d99]">EMAIL ADDRESS</label>
            <div className="relative mt-1.5">
              <Mail className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#808d99]" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="sf-input w-full py-2 pl-8 pr-3"
              />
            </div>
          </div>

          <div>
            <label className="sf-label-sm block text-[#808d99]">PASSWORD</label>
            <div className="relative mt-1.5">
              <Lock className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#808d99]" />
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 8 characters"
                className="sf-input w-full py-2 pl-8 pr-3"
              />
            </div>
          </div>

          {mode === 'login' && (
            <div className="rounded border border-[#262c32] bg-[#111417] px-3 py-2 font-mono text-[10.5px] text-[#808d99]">
              Seeded demo admin: <span className="text-[#22e55c]">admin@sagaflow.local</span> /{' '}
              <span className="text-[#f1f5f9]">sagaflow123</span>
            </div>
          )}

          {error && (
            <div className="rounded border border-[#f43f5e]/40 bg-[#f43f5e]/10 px-3 py-2 font-mono text-xs text-[#fb7185]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="sf-btn-primary w-full py-2.5 font-mono text-xs uppercase tracking-wider disabled:opacity-50"
          >
            {loading
              ? 'Authenticating...'
              : mode === 'login'
                ? 'Sign In to Workspace'
                : 'Create Account & Isolated DB'}
          </button>
        </form>
      </div>
    </div>
  );
}
