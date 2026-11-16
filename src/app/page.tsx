'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import {
  AlertIcon,
  CalendarIcon,
  PaymentIcon,
  PlusIcon,
  RefreshIcon,
  WhatsAppIcon,
} from '@/components/icons';
import { InstallmentStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { buildWhatsAppUrl } from '@/lib/financial';
import { formatCOP, formatCompactCOP } from '@/lib/money';

interface DashboardData {
  today: string;
  kpis: {
    activeCustomersCount: number;
    activeLoansCount: number;
    activeCapital: number;
    pendingPortfolio: number;
    pendingInstallmentsBalance: number;
    pendingPenaltiesTotal: number;
    estimatedPendingPenalties: number;
    collectedToday: number;
    collectedTodayCash: number;
    collectedTodayTransfer: number;
    collectedMonth: number;
    overdueInstallmentsCount: number;
    overdueAmount: number;
    dueTodayCount: number;
    dueTodayAmount: number;
    partialCount: number;
  };
  chart14d: { date: string; cash: number; transfer: number; total: number }[];
  todayQueue: {
    installment_id: string;
    loan_id: string;
    customer_id: string;
    customer_name: string;
    phone: string;
    installment_number: number;
    due_date: string;
    remaining: number;
    effective_status: string;
  }[];
  recentPayments: {
    id: string;
    customer_id: string;
    customer_name: string;
    received_amount: number;
    method: 'cash' | 'transfer';
    received_at: string;
  }[];
  regulatoryConfigured: boolean;
  holidaysCount: number;
}

export default function DashboardPage() {
  const { notify } = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error('Error al cargar el resumen');
      const json = await res.json();
      setData(json);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error cargando dashboard', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function syncPenalties() {
    setSyncing(true);
    try {
      const res = await fetch('/api/penalties/sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error sincronizando moras');
      notify(
        `Sincronización lista: ${json.updatedInstallments} cuotas actualizadas, ${json.createdPenalties} penalizaciones generadas.`,
        'success',
      );
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error al sincronizar', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const maxDayTotal = Math.max(1, ...(data?.chart14d ?? []).map((d) => d.total));

  return (
    <AppShell
      title="Dashboard"
      subtitle={data ? `Resumen financiero al ${formatDateCO(data.today)}` : 'Resumen financiero'}
      actions={
        <>
          <button
            type="button"
            onClick={syncPenalties}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshIcon className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando…' : 'Sincronizar moras'}
          </button>
          <Link
            href="/pagos"
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            <PaymentIcon className="h-3.5 w-3.5" />
            Registrar pago
          </Link>
          <Link
            href="/prestamos?nuevo=1"
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Nuevo préstamo
          </Link>
        </>
      }
    >
      {/* Holidays setup tip */}
      {data && data.holidaysCount === 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="flex items-start gap-2.5">
            <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">Calendario de festivos vacío</p>
              <p className="text-xs text-amber-800">
                Carga los festivos de Colombia en un clic para que los vencimientos y días hábiles se calculen con exactitud.
              </p>
            </div>
          </div>
          <Link
            href="/configuracion?tab=holidays"
            className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
          >
            Cargar festivos
          </Link>
        </div>
      )}

      {/* Top KPI Grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Cartera pendiente
          </p>
          <p className="tabular-nums mt-2 text-2xl font-extrabold text-slate-900">
            {loading ? '—' : formatCOP(data?.kpis.pendingPortfolio)}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            Cuotas: {formatCompactCOP(data?.kpis.pendingInstallmentsBalance)} · Mora reg:{' '}
            {formatCompactCOP(data?.kpis.pendingPenaltiesTotal)}
          </p>
        </article>

        <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recaudo de hoy
          </p>
          <p className="tabular-nums mt-2 text-2xl font-extrabold text-emerald-700">
            {loading ? '—' : formatCOP(data?.kpis.collectedToday)}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            Efectivo {formatCompactCOP(data?.kpis.collectedTodayCash)} · Transf.{' '}
            {formatCompactCOP(data?.kpis.collectedTodayTransfer)} · Mes:{' '}
            {formatCompactCOP(data?.kpis.collectedMonth)}
          </p>
        </article>

        <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Cuotas vencidas
          </p>
          <p
            className={`tabular-nums mt-2 text-2xl font-extrabold ${
              (data?.kpis.overdueInstallmentsCount ?? 0) > 0 ? 'text-rose-600' : 'text-slate-900'
            }`}
          >
            {loading ? '—' : data?.kpis.overdueInstallmentsCount ?? 0}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            Saldo en mora: {formatCOP(data?.kpis.overdueAmount)}
          </p>
        </article>

        <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Clientes y créditos
          </p>
          <p className="tabular-nums mt-2 text-2xl font-extrabold text-slate-900">
            {loading ? '—' : `${data?.kpis.activeCustomersCount ?? 0} / ${data?.kpis.activeLoansCount ?? 0}`}
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            Capital activo colocado: {formatCompactCOP(data?.kpis.activeCapital)}
          </p>
        </article>
      </div>

      {/* Chart + Daily Operations */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">Evolución de recaudos (14 días)</h2>
              <p className="text-xs text-slate-500">Pagos confirmados en efectivo y transferencia</p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-xs bg-emerald-500" /> Efectivo
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-xs bg-sky-500" /> Transferencia
              </span>
            </div>
          </div>

          <div className="mt-6 flex h-56 items-end gap-2 border-b border-slate-200 px-2 pb-2">
            {(data?.chart14d ?? []).map((day) => {
              const cashPct = Math.round((day.cash / maxDayTotal) * 100);
              const transferPct = Math.round((day.transfer / maxDayTotal) * 100);
              const shortLabel = day.date.slice(5);
              return (
                <div
                  key={day.date}
                  className="group relative flex h-full flex-1 flex-col items-center justify-end"
                >
                  <div className="pointer-events-none absolute -top-9 z-10 hidden whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-md group-hover:block">
                    {formatDateCO(day.date)}: {formatCOP(day.total)}
                  </div>
                  <div className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-t-md bg-slate-100">
                    {day.cash > 0 && (
                      <div
                        className="w-full bg-emerald-500 transition-all"
                        style={{ height: `${Math.max(4, Math.round((cashPct / 100) * 165))}px` }}
                      />
                    )}
                    {day.transfer > 0 && (
                      <div
                        className="w-full bg-sky-500 transition-all"
                        style={{
                          height: `${Math.max(4, Math.round((transferPct / 100) * 165))}px`,
                        }}
                      />
                    )}
                    {day.total === 0 && <div className="h-1 w-full bg-slate-200" />}
                  </div>
                  <span className="mt-1.5 font-mono text-[10px] text-slate-400">{shortLabel}</span>
                </div>
              );
            })}
            {!loading && (!data || data.chart14d.every((d) => d.total === 0)) && (
              <p className="sr-only">Aún no hay pagos registrados en los últimos 14 días.</p>
            )}
          </div>
          {!loading && data?.chart14d.every((d) => d.total === 0) && (
            <p className="mt-3 text-xs text-slate-400">
              Las barras reflejarán tus ingresos diarios apenas registres pagos reales.
            </p>
          )}
        </article>

        <article className="flex flex-col justify-between rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div>
            <h2 className="text-base font-bold text-slate-900">Operación del día</h2>
            <p className="text-xs text-slate-500">Estado de la agenda y cobranza</p>

            <dl className="mt-5 space-y-3.5 text-sm">
              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5">
                <dt className="text-slate-600">Cuotas con vencimiento hoy</dt>
                <dd className="tabular-nums font-bold text-slate-900">
                  {data?.kpis.dueTodayCount ?? 0} ({formatCompactCOP(data?.kpis.dueTodayAmount)})
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5">
                <dt className="text-slate-600">Cuotas con abono parcial</dt>
                <dd className="tabular-nums font-bold text-amber-700">
                  {data?.kpis.partialCount ?? 0}
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5">
                <dt className="text-slate-600">Mora estimada acumulada</dt>
                <dd className="tabular-nums font-bold text-rose-600">
                  {formatCOP(data?.kpis.estimatedPendingPenalties)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5">
            <Link
              href="/cuotas"
              className="flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <CalendarIcon className="h-3.5 w-3.5" />
              Ir a cobranza
            </Link>
            <Link
              href="/reportes"
              className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Ver reportes
            </Link>
          </div>
        </article>
      </div>

      {/* Priority Queue & Recent Payments */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">Agenda prioritaria de cobro</h2>
              <p className="text-xs text-slate-500">Cuotas vencidas o que vencen hoy</p>
            </div>
            <Link
              href="/cuotas"
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              Ver todas →
            </Link>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2.5 pr-3">Cliente</th>
                  <th className="py-2.5 px-3">Cuota</th>
                  <th className="py-2.5 px-3">Vencimiento</th>
                  <th className="py-2.5 px-3">Estado</th>
                  <th className="py-2.5 px-3 text-right">Saldo</th>
                  <th className="py-2.5 pl-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {(data?.todayQueue ?? []).map((item) => {
                  const waUrl = buildWhatsAppUrl(
                    item.phone,
                    `Hola ${item.customer_name}, te recordamos tu cuota #${item.installment_number} con vencimiento ${formatDateCO(item.due_date)} por valor de ${formatCOP(item.remaining)}.`,
                  );
                  return (
                    <tr key={item.installment_id} className="border-b border-slate-100 last:border-0">
                      <td className="py-3 pr-3 font-medium text-slate-900">
                        <Link
                          href={`/clientes/${item.customer_id}`}
                          className="hover:text-emerald-700 hover:underline"
                        >
                          {item.customer_name}
                        </Link>
                      </td>
                      <td className="py-3 px-3 text-slate-600">
                        <Link
                          href={`/prestamos/${item.loan_id}`}
                          className="font-mono text-xs hover:underline"
                        >
                          #{item.installment_number}
                        </Link>
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-600">
                        {formatDateCO(item.due_date)}
                      </td>
                      <td className="py-3 px-3">
                        <InstallmentStatusBadge status={item.effective_status} />
                      </td>
                      <td className="tabular-nums py-3 px-3 text-right font-semibold text-slate-900">
                        {formatCOP(item.remaining)}
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {waUrl && (
                            <a
                              href={waUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Enviar recordatorio WhatsApp"
                              className="rounded-lg border border-emerald-200 bg-emerald-50 p-1.5 text-emerald-700 hover:bg-emerald-100"
                            >
                              <WhatsAppIcon className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <Link
                            href={`/pagos?customerId=${item.customer_id}`}
                            className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                          >
                            Cobrar
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && (!data || data.todayQueue.length === 0) && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-sm text-slate-400">
                      No tienes cuotas vencidas ni pendientes para hoy. ¡Al día!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900">Últimos pagos</h2>
            <Link
              href="/pagos"
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              Historial →
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {(data?.recentPayments ?? []).map((pay) => (
              <div
                key={pay.id}
                className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {pay.customer_name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {pay.method === 'cash' ? 'Efectivo' : 'Transferencia'} ·{' '}
                    {formatDateTimeCO(pay.received_at)}
                  </p>
                </div>
                <span className="tabular-nums ml-2 shrink-0 text-sm font-bold text-emerald-700">
                  +{formatCOP(pay.received_amount)}
                </span>
              </div>
            ))}
            {!loading && (!data || data.recentPayments.length === 0) && (
              <p className="py-8 text-center text-sm text-slate-400">
                Aún no hay pagos registrados.
              </p>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
