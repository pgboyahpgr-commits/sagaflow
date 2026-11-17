import React from 'react';
import { Loader2 } from 'lucide-react';

interface StatusBadgeProps {
  status: string;
  size?: 'xs' | 'sm' | 'md';
}

/* Exact DESIGN.md Carbon Precision Badge Tokens (4px radius, 0.08 tint, 0.25 border, 6px dot) */
const STYLES: Record<
  string,
  { bg: string; text: string; border: string; dot: string; pulse?: boolean }
> = {
  succeeded: {
    bg: 'bg-[#22e55c]/[0.08]',
    text: 'text-[#22e55c]',
    border: 'border-[#22e55c]/25',
    dot: 'bg-[#22e55c]',
  },
  approved: {
    bg: 'bg-[#22e55c]/[0.08]',
    text: 'text-[#22e55c]',
    border: 'border-[#22e55c]/25',
    dot: 'bg-[#22e55c]',
  },
  published: {
    bg: 'bg-[#22e55c]/[0.08]',
    text: 'text-[#22e55c]',
    border: 'border-[#22e55c]/25',
    dot: 'bg-[#22e55c]',
  },
  running: {
    bg: 'bg-[#22e55c]/[0.10]',
    text: 'text-[#39ff14]',
    border: 'border-[#22e55c]/35',
    dot: 'bg-[#39ff14]',
    pulse: true,
  },
  waiting_approval: {
    bg: 'bg-[#f59e0b]/[0.08]',
    text: 'text-[#fbbf24]',
    border: 'border-[#f59e0b]/25',
    dot: 'bg-[#f59e0b]',
    pulse: true,
  },
  compensating: {
    bg: 'bg-[#a855f7]/[0.08]',
    text: 'text-[#c084fc]',
    border: 'border-[#a855f7]/25',
    dot: 'bg-[#a855f7]',
    pulse: true,
  },
  compensated: {
    bg: 'bg-[#a855f7]/[0.08]',
    text: 'text-[#c084fc]',
    border: 'border-[#a855f7]/25',
    dot: 'bg-[#a855f7]',
  },
  failed: {
    bg: 'bg-[#f43f5e]/[0.08]',
    text: 'text-[#fb7185]',
    border: 'border-[#f43f5e]/25',
    dot: 'bg-[#f43f5e]',
  },
  rejected: {
    bg: 'bg-[#f43f5e]/[0.08]',
    text: 'text-[#fb7185]',
    border: 'border-[#f43f5e]/25',
    dot: 'bg-[#f43f5e]',
  },
  cancelled: {
    bg: 'bg-[#808d99]/[0.10]',
    text: 'text-[#808d99]',
    border: 'border-[#262c32]',
    dot: 'bg-[#808d99]',
  },
  pending: {
    bg: 'bg-[#111417]',
    text: 'text-[#808d99]',
    border: 'border-[#262c32]',
    dot: 'bg-[#808d99]',
  },
  skipped: {
    bg: 'bg-[#111417]',
    text: 'text-[#808d99]',
    border: 'border-[#262c32]',
    dot: 'bg-[#808d99]',
  },
  draft: {
    bg: 'bg-[#111417]',
    text: 'text-[#808d99]',
    border: 'border-[#262c32]',
    dot: 'bg-[#808d99]',
  },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'sm' }) => {
  const s = STYLES[status] ?? STYLES.pending;
  const spinning = status === 'running' || status === 'compensating';
  const sizing =
    size === 'xs'
      ? 'px-1.5 py-0.5 text-[9px]'
      : size === 'sm'
        ? 'px-2 py-0.5 text-[9.5px]'
        : 'px-2.5 py-1 text-[10.5px]';

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border font-mono font-semibold uppercase tracking-[0.06em] ${sizing} ${s.bg} ${s.text} ${s.border}`}
    >
      {spinning ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? 'animate-pulse' : ''}`} />
      )}
      {status.replace('_', ' ')}
    </span>
  );
};
