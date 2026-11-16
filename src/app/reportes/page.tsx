'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { DownloadIcon, SearchIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { formatCOP } from '@/lib/money';

interface ReportsPayload {
  summary: {
    totalCapitalDisbursed: number;
    totalContractualInterest: number;
    totalContractualPortfolio: number;
    totalCollected: number;
    collectedCash: number;
    collectedTransfer: number;
    reversedTotal: number;
    pendingInstallmentsBalance: number;
    pendingPenaltiesBalance: number;
    overdueBalance: number;
    delinquencyRate: number;
    activeLoansCount: number;
    finishedLoansCount: number;
    blockedLoansCount: number;
  };
  agingBuckets: {
    al_dia: number;
    d1_7: number;
    d8_15: number;
    d16_30: number;
    d31_plus: number;
  };
  overdueInstallments: {
    installment_id: string;
    loan_id: string;
    customer_name: string;
    phone: string;
    installment_number: number;
    due_date: string;
    days_overdue: number;
    remaining: number;
  }[];
  payments: Record<string, unknown>[];
  exportLoans: Record<string, unknown>[];
  auditLogs: {
    id: number;
    actor_name: string;
    action: string;
    entity_type: string;
    entity_id: string | null;
    reason: string | null;
    new_data: Record<string, unknown> | null;
    created_at: string;
  }[];
  isAdmin: boolean;
}

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escapeCell = (val: unknown) => {
    const str = val == null ? '' : String(val);
    const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReportesPage() {
  const { notify } = useToast();
  const [data, setData] = useState<ReportsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'analytics' | 'audit'>('analytics');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [auditSearch, setAuditSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', toDate);
      const res = await fetch(`/api/reports?${qs.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando reportes');
      setData(json);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setLoading(false);
    }
  }, [fromDate, notify, toDate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filteredAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    const list = data?.auditLogs ?? [];
    if (!q) return list;
    return list.filter((l) =>
      `${l.action} ${l.entity_type} ${l.actor_name} ${l.reason ?? ''}`.toLowerCase().includes(q),
    );
  }, [auditSearch, data?.auditLogs]);

  const totalPending = data?.summary.pendingInstallmentsBalance ?? 0;
  const agingRows = data
    ? [
        { label: 'Al día (vigentes)', amount: data.agingBuckets.al_dia, bar: 'bg-emerald-500' },
        { label: '1 a 7 días vencida', amount: data.agingBuckets.d1_7, bar: 'bg-amber-500' },
        { label: '8 a 15 días vencida', amount: data.agingBuckets.d8_15, bar: 'bg-orange-500' },
        { label: '16 a 30 días vencida', amount: data.agingBuckets.d16_30, bar: 'bg-rose-500' },
        { label: 'Más de 30 días', amount: data.agingBuckets.d31_plus, bar: 'bg-rose-800' },
      ]
    : [];

  return (
    <AppShell
      title="Reportes y Auditoría"
      subtitle="Rentabilidad, envejecimiento de cartera, exportaciones CSV y bitácora legal"
      actions={
        data && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => downloadCsv('cartera_prestamos.csv', data.exportLoans)}
              disabled={data.exportLoans.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              Préstamos CSV
            </button>
            <button
              type="button"
              onClick={() => downloadCsv('pagos_recaudados.csv', data.payments)}
              disabled={data.payments.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              Pagos CSV
            </button>
            <button
              type="button"
              onClick={() => downloadCsv('cartera_vencida.csv', data.overdueInstallments)}
              disabled={data.overdueInstallments.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              Morosos CSV
            </button>
          </div>
        )
      }
    >
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setTab('analytics')}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
              tab === 'analytics' ? 'bg-slate-900 text-white' : 'text-slate-600'
            }`}
          >
            Analítica de cartera
          </button>
          {data?.isAdmin && (
            <button
              type="button"
              onClick={() => setTab('audit')}
              className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                tab === 'audit' ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              Auditoría ({data.auditLogs.length})
            </button>
          )}
        </div>

        {tab === 'analytics' && (
          <div className="flex flex-wrap items-end gap-2.5">
            <label className="text-xs">
              Desde
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-auto py-1.5 text-xs"
              />
            </label>
            <label className="text-xs">
              Hasta
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-auto py-1.5 text-xs"
              />
            </label>
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                }}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Limpiar filtro
              </button>
            )}
          </div>
        )}
      </div>

      {loading && <p className="text-sm text-slate-500">Calculando indicadores…</p>}

      {!loading && data && tab === 'analytics' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <p className="text-xs text-slate-500">Capital desembolsado</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-slate-900">
                {formatCOP(data.summary.totalCapitalDisbursed)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Interés pactado: {formatCOP(data.summary.totalContractualInterest)}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <p className="text-xs text-slate-500">Total recaudado</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-emerald-700">
                {formatCOP(data.summary.totalCollected)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Efectivo {formatCOP(data.summary.collectedCash)} · Transf.{' '}
                {formatCOP(data.summary.collectedTransfer)}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <p className="text-xs text-slate-500">Saldo pendiente por cobrar</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-slate-900">
                {formatCOP(
                  data.summary.pendingInstallmentsBalance + data.summary.pendingPenaltiesBalance,
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Activos: {data.summary.activeLoansCount} · Finalizados:{' '}
                {data.summary.finishedLoansCount}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <p className="text-xs text-slate-500">Índice de morosidad</p>
              <p
                className={`tabular-nums mt-1.5 text-2xl font-extrabold ${
                  data.summary.delinquencyRate > 15 ? 'text-rose-600' : 'text-slate-900'
                }`}
              >
                {data.summary.delinquencyRate}%
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Saldo vencido: {formatCOP(data.summary.overdueBalance)}
              </p>
            </article>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <h2 className="text-base font-bold text-slate-900">Antigüedad de cartera</h2>
              <p className="text-xs text-slate-500">Distribución actual del saldo pendiente</p>
              <div className="mt-5 space-y-4">
                {agingRows.map((row) => {
                  const pct = totalPending > 0 ? Math.round((row.amount / totalPending) * 100) : 0;
                  return (
                    <div key={row.label}>
                      <div className="flex justify-between text-xs">
                        <span className="font-medium text-slate-700">{row.label}</span>
                        <span className="tabular-nums font-bold text-slate-900">
                          {formatCOP(row.amount)} ({pct}%)
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full rounded-full ${row.bar}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {data.summary.reversedTotal > 0 && (
                <p className="mt-5 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  Pagos reversados en el período: <b>{formatCOP(data.summary.reversedTotal)}</b>
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
              <h2 className="text-base font-bold text-slate-900">
                Detalle de cuotas en mora ({data.overdueInstallments.length})
              </h2>
              <div className="mt-4 max-h-96 overflow-y-auto overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 border-b border-slate-200 bg-white text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Cliente</th>
                      <th className="py-2 px-3">Cuota</th>
                      <th className="py-2 px-3">Venció</th>
                      <th className="py-2 px-3 text-right">Días atraso</th>
                      <th className="py-2 pl-3 text-right">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.overdueInstallments.map((item) => (
                      <tr key={item.installment_id} className="border-b border-slate-100 last:border-0">
                        <td className="py-2.5 pr-3 font-medium text-slate-900">
                          <Link href={`/prestamos/${item.loan_id}`} className="hover:underline">
                            {item.customer_name}
                          </Link>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs">#{item.installment_number}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-600">
                          {formatDateCO(item.due_date)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-semibold text-rose-600">
                          {item.days_overdue}d
                        </td>
                        <td className="tabular-nums py-2.5 pl-3 text-right font-bold text-slate-900">
                          {formatCOP(item.remaining)}
                        </td>
                      </tr>
                    ))}
                    {data.overdueInstallments.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                          Excelente: no tienes cuotas vencidas en este momento.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </>
      )}

      {!loading && data && tab === 'audit' && data.isAdmin && (
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Bitácora de auditoría</h2>
              <p className="text-xs text-slate-500">
                Registro inmutable de movimientos sensibles del sistema
              </p>
            </div>
            <div className="relative min-w-60 flex-1 sm:max-w-xs">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Filtrar acción, actor o motivo…"
                className="pl-9"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 uppercase text-slate-500">
                <tr>
                  <th className="py-2.5 pr-3">Fecha</th>
                  <th className="py-2.5 px-3">Usuario</th>
                  <th className="py-2.5 px-3">Acción</th>
                  <th className="py-2.5 px-3">Entidad</th>
                  <th className="py-2.5 pl-3">Detalle / Motivo</th>
                </tr>
              </thead>
              <tbody>
                {filteredAudit.map((log) => (
                  <tr key={log.id} className="border-b border-slate-100 last:border-0">
                    <td className="whitespace-nowrap py-2.5 pr-3 text-slate-600">
                      {formatDateTimeCO(log.created_at)}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-900">{log.actor_name}</td>
                    <td className="py-2.5 px-3 font-mono font-semibold text-emerald-700">
                      {log.action}
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      {log.entity_type}
                      {log.entity_id ? ` · ${log.entity_id.slice(0, 8)}` : ''}
                    </td>
                    <td className="py-2.5 pl-3 text-slate-600">
                      {log.reason && <p className="font-semibold text-slate-900">{log.reason}</p>}
                      {log.new_data && (
                        <code className="text-[11px] text-slate-500">
                          {JSON.stringify(log.new_data)}
                        </code>
                      )}
                    </td>
                  </tr>
                ))}
                {filteredAudit.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                      No hay registros de auditoría aún.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </AppShell>
  );
}
