'use client';

import type { ReactNode } from 'react';

type ReportHeaderStat = {
  label: string;
  value: string | number;
};

type ReportHeaderProps = {
  title: string;
  subtitle: string;
  restaurantName: string;
  stats?: ReportHeaderStat[];
  rightSlot?: ReactNode;
};

function getInitials(name: string): string {
  const parts = name
    .split(' ')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'SF';
  const initials = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
  return initials || 'SF';
}

export function ReportHeader({
  title,
  subtitle,
  restaurantName,
  stats,
  rightSlot,
}: ReportHeaderProps) {
  const initials = getInitials(restaurantName);

  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-4 border-b border-theme-primary pb-4 print:border-zinc-200">
      <div className="flex items-center gap-3 min-w-[200px]">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/15 text-xs font-bold text-amber-400 print:bg-amber-100 print:text-amber-700">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[10px] uppercase tracking-[0.2em] text-theme-muted print:text-zinc-400">
            {restaurantName}
          </div>
          <div className="text-sm font-semibold text-theme-primary print:text-zinc-900">{title}</div>
          <div className="text-xs text-theme-secondary print:text-zinc-500">{subtitle}</div>
        </div>
      </div>

      {stats && stats.length > 0 && (
        <div className="rounded-xl border border-theme-primary bg-theme-secondary px-3 py-2 print:border-zinc-200 print:bg-zinc-50">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-5 gap-y-2">
            {stats.map((stat) => (
              <div key={stat.label} className="min-w-[86px]">
                <div className="text-[9px] uppercase tracking-[0.18em] text-theme-muted print:text-zinc-400">
                  {stat.label}
                </div>
                <div className="text-base font-bold leading-tight text-theme-primary print:text-zinc-900">{stat.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {rightSlot && <div className="ml-auto">{rightSlot}</div>}
    </div>
  );
}
