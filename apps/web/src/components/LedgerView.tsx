import React, { useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Database,
  ExternalLink,
  Inbox,
  KeyRound,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wallet,
} from 'lucide-react';
import type { TenantStateSnapshot } from '@sagaflow/shared';
import { api, type TenantSession } from '../lib/api';

interface LedgerViewProps {
  session: TenantSession;
  tenantSlug: string;
  onInspectRun: (runId: string) => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  session,
  tenantSlug,
  onInspectRun,
  onNotify,
}) => {
  const [state, setState] = useState<TenantStateSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'overview' | 'ledger' | 'sink' | 'kv'>('overview');

  // Restock Inventory form
  const [invSku, setInvSku] = useState('SKU-PRO-900');
  const [invName, setInvName] = useState('');
  const [invDelta, setInvDelta] = useState(50);

  // Adjust Balance form
  const [balAccount, setBalAccount] = useState('customer_wallet');
  const [balCurrency, setBalCurrency] = useState('USD');
  const [balDelta, setBalDelta] = useState(500);

  // KV form
  const [kvKey, setKvKey] = useState('');
  const [kvValue, setKvValue] = useState('{"status":"active"}');

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.getTenantState(session);
      setState(res.state);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load tenant state', 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.apiKey, session.token]);

  const handleAdjustInventory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invSku.trim() || invDelta === 0) return;
    try {
      await api.adjustInventory(session, {
        sku: invSku.trim(),
        name: invName.trim() || undefined,
        deltaAvailable: Number(invDelta),
      });
      onNotify(`Updated ${invSku.trim()} by ${invDelta > 0 ? '+' : ''}${invDelta} units`, 'ok');
      setInvName('');
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Inventory update failed', 'err');
    }
  };

  const handleAdjustBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!balAccount.trim() || balDelta === 0) return;
    try {
      await api.adjustBalance(session, {
        accountId: balAccount.trim(),
        currency: balCurrency.trim() || 'USD',
        deltaAvailable: Number(balDelta),
      });
      onNotify(`Adjusted ${balAccount.trim()} by ${balDelta > 0 ? '+' : ''}${balDelta}`, 'ok');
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Balance adjustment failed', 'err');
    }
  };

  const handleSetKv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kvKey.trim()) return;
    let parsed: unknown = kvValue;
    try {
      parsed = JSON.parse(kvValue);
    } catch {
      parsed = kvValue;
    }
    try {
      await api.setKv(session, kvKey.trim(), parsed);
      onNotify(`Saved KV key "${kvKey.trim()}"`, 'ok');
      setKvKey('');
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'KV write failed', 'err');
    }
  };

  const handleDeleteKv = async (key: string) => {
    try {
      await api.deleteKv(session, key);
      onNotify(`Deleted KV key "${key}"`, 'ok');
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'err');
    }
  };

  const handleClearSink = async () => {
    try {
      await api.clearSinkDeliveries(session);
      onNotify('Cleared persisted Webhook Sink deliveries', 'info');
      await refresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to clear sink', 'err');
    }
  };

  const inventory = state?.inventory ?? [];
  const balances = state?.balances ?? [];
  const ledger = state?.ledger ?? [];
  const sink = state?.sinkDeliveries ?? [];
  const kv = state?.kv ?? [];

  const committedCount = ledger.filter(
    (e) => e.direction === 'execute' && e.status === 'committed'
  ).length;
  const rollbackCount = ledger.filter((e) => e.direction === 'compensate').length;

  return (
    <div className="sf-surface-bg h-full overflow-y-auto p-5 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
          <span className="tracking-[0.12em] text-[#808d99]">
            STATE / TENANT_LEDGER / <span className="text-[#22e55c]">ZERO_MOCK_STORAGE</span>
          </span>
          <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[#808d99]">
            SINK ENDPOINT: <strong className="text-[#22e55c]">/api/sink/{tenantSlug}/:channel</strong>
          </span>
        </div>

        {/* Header + Sub-Tab Strip */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] text-[#22e55c]">
              <Database className="h-4.5 w-4.5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-[#f1f5f9]">
                Live Database State &amp; Saga Ledger
              </h1>
              <p className="mt-1 text-xs text-[#808d99]">
                Every workflow step mutates real rows inside this tenant&apos;s isolated database
                and writes atomic before/after rollback proofs.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded border border-[#262c32] bg-[#111417] p-0.5 font-mono text-[11px]">
              {(
                [
                  { id: 'overview', label: 'Inventory & Wallets' },
                  { id: 'ledger', label: `Saga Ledger (${ledger.length})` },
                  { id: 'sink', label: `Webhook Sink (${sink.length})` },
                  { id: 'kv', label: `KV Store (${kv.length})` },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-[3px] px-2.5 py-1.5 font-medium transition ${
                    tab === t.id
                      ? 'bg-[#22e55c]/[0.12] text-[#22e55c]'
                      : 'text-[#808d99] hover:text-[#f1f5f9]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void refresh()}
              className="sf-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px]"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#22e55c]' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* 4 Zero-Shadow Tier-1 KPI Cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="sf-card sf-top-neon p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>TRACKED SKUS</span>
              <Package className="h-3.5 w-3.5 text-[#22e55c]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#f1f5f9]">
              {inventory.length}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              {inventory.reduce((sum, i) => sum + i.available, 0).toLocaleString()} avail ·{' '}
              {inventory.reduce((sum, i) => sum + i.reserved, 0).toLocaleString()} rsvd
            </div>
          </div>

          <div className="sf-card sf-top-neon p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>LEDGER COMMITS</span>
              <ArrowUpRight className="h-3.5 w-3.5 text-[#22e55c]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#22e55c]">
              {committedCount}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              Forward database mutations
            </div>
          </div>

          <div className="sf-card sf-top-violet p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>SAGA ROLLBACKS</span>
              <RotateCcw className="h-3.5 w-3.5 text-[#a855f7]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#c084fc]">
              {rollbackCount}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              Exact inverse compensations
            </div>
          </div>

          <div className="sf-card sf-top-amber p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>HTTP SINK HITS</span>
              <Inbox className="h-3.5 w-3.5 text-[#f59e0b]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#fbbf24]">
              {sink.length}
            </div>
            <div className="mt-1 truncate font-mono text-[10.5px] text-[#808d99]">
              /api/sink/{tenantSlug}/:channel
            </div>
          </div>
        </div>

        {/* TAB 1: INVENTORY & WALLETS */}
        {tab === 'overview' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* Warehouse Inventory */}
            <div className="sf-card p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-[#22e55c]" />
                  <h3 className="text-sm font-semibold text-[#f1f5f9]">
                    Warehouse Inventory (Real DB)
                  </h3>
                </div>
                <span className="rounded border border-[#22e55c]/25 bg-[#22e55c]/[0.08] px-2 py-0.5 font-mono text-[10px] text-[#22e55c]">
                  reserve_inventory / release
                </span>
              </div>

              <div className="mt-4 space-y-2.5">
                {inventory.map((item) => {
                  const total = Math.max(1, item.available + item.reserved);
                  const availPct = Math.round((item.available / total) * 100);
                  return (
                    <div
                      key={item.sku}
                      className="rounded border border-[#262c32] bg-[#111417] p-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-[#22e55c]">
                              {item.sku}
                            </span>
                            <span className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.5 font-mono text-[10px] text-[#808d99]">
                              {item.warehouse}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-[#c7d1db]">{item.name}</div>
                        </div>
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-sm font-bold text-[#f1f5f9]">
                            {item.available.toLocaleString()}{' '}
                            <span className="text-[10px] font-normal text-[#808d99]">avail</span>
                          </div>
                          <div className="text-[11px] text-[#fbbf24]">
                            {item.reserved.toLocaleString()} reserved
                          </div>
                        </div>
                      </div>
                      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-[2px] bg-[#1c2227]">
                        <div
                          className="h-full bg-[#22e55c] transition-all duration-300"
                          style={{ width: `${availPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {inventory.length === 0 && (
                  <p className="py-4 text-center font-mono text-xs text-[#808d99]">
                    No inventory SKUs yet. Add one below.
                  </p>
                )}
              </div>

              <form
                onSubmit={handleAdjustInventory}
                className="mt-4 rounded border border-[#262c32] bg-[#111417] p-3"
              >
                <div className="sf-label-sm mb-2 text-[#808d99]">RESTOCK / ADJUST SKU</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    value={invSku}
                    onChange={(e) => setInvSku(e.target.value)}
                    placeholder="SKU-PRO-900"
                    className="sf-input px-2.5 py-1.5"
                  />
                  <input
                    value={invName}
                    onChange={(e) => setInvName(e.target.value)}
                    placeholder="Label (optional)"
                    className="sf-input px-2.5 py-1.5 font-sans"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      value={invDelta}
                      onChange={(e) => setInvDelta(Number(e.target.value))}
                      className="sf-input w-20 px-2 py-1.5"
                    />
                    <button
                      type="submit"
                      className="sf-btn-primary flex flex-1 items-center justify-center gap-1 px-3 py-1.5 font-mono text-[11px] uppercase"
                    >
                      <Plus className="h-3.5 w-3.5" /> Apply
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {/* Wallets & Loyalty Balances */}
            <div className="sf-card p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-[#22e55c]" />
                  <h3 className="text-sm font-semibold text-[#f1f5f9]">
                    Accounts, Wallets &amp; Credits (Real DB)
                  </h3>
                </div>
                <span className="rounded border border-[#22e55c]/25 bg-[#22e55c]/[0.08] px-2 py-0.5 font-mono text-[10px] text-[#22e55c]">
                  charge_payment / credits
                </span>
              </div>

              <div className="mt-4 space-y-2.5">
                {balances.map((b) => (
                  <div
                    key={b.accountId}
                    className="flex items-center justify-between rounded border border-[#262c32] bg-[#111417] p-3.5"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <Coins className="h-3.5 w-3.5 text-[#22e55c]" />
                        <span className="font-mono text-xs font-semibold text-[#22e55c]">
                          {b.accountId}
                        </span>
                        <span className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.5 font-mono text-[10px] text-[#808d99]">
                          {b.currency}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-[#c7d1db]">{b.label}</div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div className="text-base font-bold text-[#f1f5f9]">
                        {b.currency === 'USD' ? '$' : ''}
                        {b.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                        {b.currency !== 'USD' ? b.currency : ''}
                      </div>
                      {b.locked > 0 && (
                        <div className="text-[11px] text-[#fbbf24]">
                          {b.locked.toLocaleString()} locked
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <form
                onSubmit={handleAdjustBalance}
                className="mt-4 rounded border border-[#262c32] bg-[#111417] p-3"
              >
                <div className="sf-label-sm mb-2 text-[#808d99]">TOP-UP / ADJUST ACCOUNT</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <input
                    value={balAccount}
                    onChange={(e) => setBalAccount(e.target.value)}
                    placeholder="customer_wallet"
                    className="sf-input px-2.5 py-1.5"
                  />
                  <input
                    value={balCurrency}
                    onChange={(e) => setBalCurrency(e.target.value)}
                    placeholder="USD / PTS"
                    className="sf-input px-2.5 py-1.5"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      step="any"
                      value={balDelta}
                      onChange={(e) => setBalDelta(Number(e.target.value))}
                      className="sf-input w-20 px-2 py-1.5"
                    />
                    <button
                      type="submit"
                      className="sf-btn-primary flex flex-1 items-center justify-center gap-1 px-3 py-1.5 font-mono text-[11px] uppercase"
                    >
                      <Plus className="h-3.5 w-3.5" /> Apply
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* TAB 2: IMMUTABLE SAGA TRANSACTION LEDGER */}
        {tab === 'ledger' && (
          <div className="sf-card overflow-hidden">
            <div className="border-b border-[#262c32] bg-[#111417] px-5 py-3">
              <h3 className="text-sm font-semibold text-[#f1f5f9]">
                Immutable Saga Transaction Log
              </h3>
              <p className="text-xs text-[#808d99]">
                Proof of every real forward commit and reverse Saga rollback with exact before/after
                state snapshots.
              </p>
            </div>
            <div className="divide-y divide-[#262c32]/80">
              {ledger.map((entry) => {
                const isComp = entry.direction === 'compensate';
                return (
                  <div key={entry.id} className="px-5 py-3.5 transition hover:bg-[#181e23]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 font-mono">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${
                            isComp
                              ? 'border border-[#a855f7]/35 bg-[#a855f7]/[0.10] text-[#c084fc]'
                              : entry.status === 'failed'
                                ? 'border border-[#f43f5e]/35 bg-[#f43f5e]/[0.10] text-[#fb7185]'
                                : 'border border-[#22e55c]/35 bg-[#22e55c]/[0.10] text-[#22e55c]'
                          }`}
                        >
                          {isComp ? (
                            <ArrowDownLeft className="h-3 w-3" />
                          ) : (
                            <ArrowUpRight className="h-3 w-3" />
                          )}
                          {isComp ? 'ROLLBACK' : entry.status.toUpperCase()}
                        </span>
                        <span className="text-xs font-semibold text-[#f1f5f9]">{entry.action}</span>
                        <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 text-[10px] text-[#808d99]">
                          {entry.resourceType}:{entry.resourceId}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[11px] text-[#808d99]">
                        {entry.runId !== 'manual_ops' && (
                          <button
                            onClick={() => onInspectRun(entry.runId)}
                            className="inline-flex items-center gap-1 text-[#22e55c] hover:underline"
                          >
                            {entry.runId}
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                        <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                    <div className="mt-1.5 text-xs text-[#c7d1db]">{entry.summary}</div>
                    {(entry.beforeState || entry.afterState) && (
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {entry.beforeState && (
                          <div className="rounded border border-[#262c32] bg-[#111417] px-2.5 py-1.5 font-mono text-[10px] text-[#808d99]">
                            <span className="text-[#808d99]">before: </span>
                            {JSON.stringify(entry.beforeState)}
                          </div>
                        )}
                        {entry.afterState && (
                          <div className="rounded border border-[#262c32] bg-[#111417] px-2.5 py-1.5 font-mono text-[10px] text-[#73ff86]">
                            <span className="text-[#808d99]">after: </span>
                            {JSON.stringify(entry.afterState)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {ledger.length === 0 && (
                <div className="p-10 text-center font-mono text-xs text-[#808d99]">
                  Run any workflow to watch real atomic commits &amp; rollbacks stream into the
                  ledger.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: REAL HTTP WEBHOOK SINK */}
        {tab === 'sink' && (
          <div className="sf-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#262c32] bg-[#111417] px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold text-[#f1f5f9]">
                  Real Persisted HTTP Webhook Sink
                </h3>
                <p className="text-xs text-[#808d99]">
                  Any workflow HTTP node or external <code className="text-[#22e55c]">curl</code>{' '}
                  sent to{' '}
                  <code className="text-[#22e55c]">/api/sink/{tenantSlug}/&lt;channel&gt;</code> is
                  captured live here.
                </p>
              </div>
              {sink.length > 0 && (
                <button
                  onClick={() => void handleClearSink()}
                  className="sf-btn-danger inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] uppercase"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Clear Inbox
                </button>
              )}
            </div>
            <div className="divide-y divide-[#262c32]/80">
              {sink.map((d) => (
                <div key={d.id} className="p-4 transition hover:bg-[#181e23]">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.10] px-2 py-0.5 text-[10.5px] font-bold text-[#22e55c]">
                        {d.method}
                      </span>
                      <span className="text-xs font-medium text-[#f1f5f9]">{d.path}</span>
                      <span className="rounded border border-[#22e55c]/25 bg-[#22e55c]/[0.08] px-1.5 py-0.5 text-[10px] text-[#22e55c]">
                        {d.statusCode} OK
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-[#808d99]">
                      <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 text-[10px] text-[#22e55c]">
                        {d.channel}
                      </span>
                      <span>{new Date(d.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                  <div className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div className="rounded border border-[#262c32] bg-[#111417] p-2.5">
                      <div className="sf-label-sm mb-1 text-[#808d99]">HEADERS</div>
                      <pre className="max-h-28 overflow-auto font-mono text-[10px] text-[#c7d1db]">
                        {JSON.stringify(d.headers, null, 2)}
                      </pre>
                    </div>
                    <div className="rounded border border-[#262c32] bg-[#111417] p-2.5">
                      <div className="sf-label-sm mb-1 text-[#808d99]">PAYLOAD BODY</div>
                      <pre className="max-h-28 overflow-auto font-mono text-[10px] text-[#73ff86]">
                        {JSON.stringify(d.body, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
              {sink.length === 0 && (
                <div className="p-10 text-center font-mono text-xs text-[#808d99]">
                  No webhook sink deliveries yet. Run the High-Value Approval Router workflow or
                  send a live HTTP request from Studio!
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: TENANT KV STORE */}
        {tab === 'kv' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="sf-card p-5 lg:col-span-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#f59e0b]" />
                <h3 className="text-sm font-semibold text-[#f1f5f9]">
                  Persistent Tenant KV Store
                </h3>
              </div>
              <p className="mt-0.5 text-xs text-[#808d99]">
                Read and mutated atomically by the{' '}
                <code className="font-mono text-[#22e55c]">kv_set</code> /{' '}
                <code className="font-mono text-[#c084fc]">kv_revert</code> Saga task handler or
                directly below.
              </p>
              <div className="mt-4 space-y-2">
                {kv.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-start justify-between gap-3 rounded border border-[#262c32] bg-[#111417] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs font-semibold text-[#fbbf24]">{r.key}</div>
                      <pre className="mt-1 overflow-auto font-mono text-[11px] text-[#f1f5f9]">
                        {JSON.stringify(r.value, null, 2)}
                      </pre>
                    </div>
                    <button
                      onClick={() => void handleDeleteKv(r.key)}
                      className="sf-btn-danger p-1.5"
                      title="Delete key"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {kv.length === 0 && (
                  <div className="rounded border border-dashed border-[#262c32] p-8 text-center font-mono text-xs text-[#808d99]">
                    No KV records yet. Add a key on the right or use the{' '}
                    <code className="text-[#22e55c]">kv_set</code> task handler.
                  </div>
                )}
              </div>
            </div>

            <form onSubmit={handleSetKv} className="sf-card h-fit space-y-3 p-5">
              <h3 className="text-sm font-semibold text-[#f1f5f9]">Upsert Key</h3>
              <div>
                <label className="sf-label-sm block text-[#808d99]">KEY</label>
                <input
                  value={kvKey}
                  onChange={(e) => setKvKey(e.target.value)}
                  placeholder="order:ORD-1001"
                  className="sf-input mt-1 w-full px-3 py-2"
                />
              </div>
              <div>
                <label className="sf-label-sm block text-[#808d99]">JSON VALUE</label>
                <textarea
                  rows={5}
                  value={kvValue}
                  onChange={(e) => setKvValue(e.target.value)}
                  className="sf-input mt-1 w-full p-2.5 text-[#73ff86]"
                />
              </div>
              <button
                type="submit"
                className="sf-btn-primary w-full py-2 font-mono text-[11px] uppercase tracking-wider"
              >
                Save to Tenant DB
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
