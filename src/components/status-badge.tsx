import type { InstallmentStatus, LoanStatus } from '@/lib/financial';

const LOAN_STATUS_MAP: Record<LoanStatus, { label: string; cls: string }> = {
  active: { label: 'Activo', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  draft: { label: 'Borrador', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  finished: { label: 'Finalizado', cls: 'bg-sky-50 text-sky-700 ring-sky-200' },
  blocked: { label: 'Bloqueado', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
  archived: { label: 'Archivado', cls: 'bg-zinc-100 text-zinc-600 ring-zinc-200' },
};

const INSTALLMENT_STATUS_MAP: Record<InstallmentStatus, { label: string; cls: string }> = {
  paid: { label: 'Pagada', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  pending: { label: 'Pendiente', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  partial: { label: 'Abono parcial', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  overdue: { label: 'Vencida', cls: 'bg-rose-50 text-rose-700 ring-rose-200' },
  overdue_partial: { label: 'Vencida parcial', cls: 'bg-orange-50 text-orange-800 ring-orange-200' },
};

export function LoanStatusBadge({ status }: { status: LoanStatus | string }) {
  const cfg = LOAN_STATUS_MAP[status as LoanStatus] ?? {
    label: status,
    cls: 'bg-slate-100 text-slate-700 ring-slate-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

export function InstallmentStatusBadge({ status }: { status: InstallmentStatus | string }) {
  const cfg = INSTALLMENT_STATUS_MAP[status as InstallmentStatus] ?? {
    label: status,
    cls: 'bg-slate-100 text-slate-700 ring-slate-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}
