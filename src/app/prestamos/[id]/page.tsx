'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { AppShell, useSessionInfo } from '@/components/app-shell';
import {
  CloseIcon,
  PaymentIcon,
  PrinterIcon,
  RefreshIcon,
  WhatsAppIcon,
} from '@/components/icons';
import { InstallmentStatusBadge, LoanStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { buildWhatsAppUrl, FREQUENCY_LABELS, type Frequency } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface PenaltyRow {
  id: string;
  installment_id: string;
  period_number: number;
  amount: number;
  days_counted: number;
  paid_amount: number;
  generated_at: string;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  scheduled_due_date: string;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  status: string;
  effective_status: string;
  remaining_amount: number;
  days_late: number;
  penalty_frozen: boolean;
  penalties: PenaltyRow[];
  recorded_penalties_remaining: number;
  estimated_penalties_remaining: number;
}

interface LoanDetailPayload {
  loan: {
    id: string;
    customer_id: string;
    capital: number;
    interest_rate: number;
    contractual_interest: number;
    contractual_total: number;
    frequency: Frequency;
    installments_count: number;
    disbursement_date: string;
    first_payment_date: string;
    notes: string | null;
    status: string;
    regulatory_snapshot: Record<string, unknown>;
    terms_snapshot: Record<string, unknown>;
    created_at: string;
  };
  customer: {
    id: string;
    first_names: string;
    last_names: string;
    document_type: string;
    document_number: string;
    phone: string;
  } | null;
  installments: InstallmentRow[];
  payments: {
    id: string;
    received_amount: number;
    method: 'cash' | 'transfer';
    transfer_reference: string | null;
    received_at: string;
    reversed_at: string | null;
  }[];
  adjustments: {
    id: string;
    adjustment_type: string;
    amount: number;
    reason: string;
    created_at: string;
  }[];
  summary: {
    billingMode?: 'fixed_installments' | 'monthly_interest_only';
    currentCapital?: number;
    capitalPaid?: number;
    totalPaid: number;
    remainingInstallments: number;
    recordedPenaltiesPending: number;
    estimatedPenaltiesPending: number;
    totalRemaining: number;
    overdueCount: number;
    paidCount: number;
    installmentsCount: number;
  };
}

function LoanDetailContent() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useSessionInfo();
  const { notify } = useToast();

  const [data, setData] = useState<LoanDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);

  // Financial adjustment modal (admin only)
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjType, setAdjType] = useState<'installment_discount' | 'penalty_waiver' | 'note_adjustment'>(
    'installment_discount',
  );
  const [adjInstId, setAdjInstId] = useState('');
  const [adjPenId, setAdjPenId] = useState('');
  const [adjAmount, setAdjAmount] = useState(0);
  const [adjReason, setAdjReason] = useState('');

  // Add capital (retanqueo) modal (admin only for monthly_interest_only)
  const [capOpen, setCapOpen] = useState(false);
  const [capAmount, setCapAmount] = useState('');
  const [capReason, setCapReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/loans/${id}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando préstamo');
      setData(json);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setLoading(false);
    }
  }, [id, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function changeStatus(status: 'active' | 'blocked' | 'finished' | 'archived') {
    setBusyAction(true);
    try {
      const res = await fetch(`/api/loans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change_status', status }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error actualizando estado');
      notify('Estado del préstamo actualizado.', 'success');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  async function toggleFreeze(inst: InstallmentRow) {
    setBusyAction(true);
    try {
      const res = await fetch(`/api/loans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggle_penalty_freeze',
          installment_id: inst.id,
          penalty_frozen: !inst.penalty_frozen,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error actualizando mora');
      notify(
        !inst.penalty_frozen
          ? `Mora congelada en cuota #${inst.installment_number}.`
          : `Mora reactivada en cuota #${inst.installment_number}.`,
        'success',
      );
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  async function syncPenalties() {
    setBusyAction(true);
    try {
      const res = await fetch('/api/penalties/sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error sincronizando moras');
      notify(
        `Sincronización lista (${json.createdPenalties} penalizaciones nuevas).`,
        'success',
      );
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  async function submitAdjustment(e: FormEvent) {
    e.preventDefault();
    setBusyAction(true);
    try {
      const res = await fetch('/api/adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loan_id: id,
          adjustment_type: adjType,
          installment_id: adjType === 'installment_discount' ? adjInstId || null : null,
          penalty_id: adjType === 'penalty_waiver' ? adjPenId || null : null,
          amount: adjType === 'note_adjustment' ? 0 : Math.max(0, Math.round(adjAmount)),
          reason: adjReason,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'No fue posible aplicar el ajuste');
      notify('Ajuste financiero aplicado y auditado.', 'success');
      setAdjOpen(false);
      setAdjReason('');
      setAdjAmount(0);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  async function submitAddCapital(e: FormEvent) {
    e.preventDefault();
    const amt = Math.round(Number(capAmount) || 0);
    if (amt <= 0) {
      notify('Ingresa un valor positivo de capital.', 'error');
      return;
    }
    setBusyAction(true);
    try {
      const res = await fetch(`/api/loans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add_capital',
          amount: amt,
          reason: capReason,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error agregando capital');
      notify(`Capital ampliado en ${formatCOP(amt)}.`, 'success');
      setCapOpen(false);
      setCapAmount('');
      setCapReason('');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleCapitalizeInterest(inst: InstallmentRow) {
    setBusyAction(true);
    try {
      const res = await fetch(`/api/loans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'capitalize_interest',
          installment_id: inst.id,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error capitalizando interés');
      notify(`Interés de cuota #${inst.installment_number} sumado al capital.`, 'success');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setBusyAction(false);
    }
  }

  const loan = data?.loan;
  const customer = data?.customer;
  const customerName = customer ? `${customer.first_names} ${customer.last_names}` : 'Préstamo';

  const openInstallments = (data?.installments ?? []).filter((i) => i.remaining_amount > 0);
  const openPenalties = (data?.installments ?? []).flatMap((i) =>
    i.penalties
      .filter((p) => Number(p.amount) > Number(p.paid_amount))
      .map((p) => ({ ...p, installment_number: i.installment_number })),
  );

  const waSummaryUrl =
    loan && customer && data
      ? buildWhatsAppUrl(
          customer.phone,
          [
            `Hola ${customer.first_names}, resumen de tu crédito en Nexo Crédito:`,
            `Total pactado: ${formatCOP(loan.contractual_total)}`,
            `Pagado: ${formatCOP(data.summary.totalPaid)}`,
            `Saldo pendiente: ${formatCOP(data.summary.totalRemaining)}`,
            `Cuotas pagadas: ${data.summary.paidCount}/${data.summary.installmentsCount}`,
          ].join('\n'),
        )
      : null;

  const progressPct =
    loan && data && loan.contractual_total > 0
      ? Math.min(100, Math.round((data.summary.totalPaid / loan.contractual_total) * 100))
      : 0;

  return (
    <AppShell
      title={`Crédito · ${customerName}`}
      subtitle={
        loan
          ? `${FREQUENCY_LABELS[loan.frequency] ?? loan.frequency} · ${loan.installments_count} cuotas · Desembolso ${formatDateCO(loan.disbursement_date)}`
          : 'Cargando detalle del préstamo…'
      }
      actions={
        loan && (
          <>
            <Link
              href="/prestamos"
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              ← Préstamos
            </Link>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <PrinterIcon className="h-3.5 w-3.5" />
              Imprimir plan
            </button>
            {waSummaryUrl && (
              <a
                href={waSummaryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <WhatsAppIcon className="h-3.5 w-3.5" />
                WhatsApp
              </a>
            )}
            {customer && (loan.status === 'active' || loan.status === 'blocked') && (
              <Link
                href={`/pagos?customerId=${customer.id}`}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <PaymentIcon className="h-3.5 w-3.5" />
                Registrar pago
              </Link>
            )}
          </>
        )
      }
    >
      {loading && <p className="text-sm text-slate-500">Cargando cronograma y movimientos…</p>}

      {!loading && data && loan && (
        <>
          {/* Summary Banner */}
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <LoanStatusBadge status={loan.status} />
                <span className="font-mono text-xs text-slate-400">ID {loan.id.slice(0, 8)}</span>
                {customer && (
                  <Link
                    href={`/clientes/${customer.id}`}
                    className="text-xs font-semibold text-emerald-700 hover:underline"
                  >
                    Ver ficha de {customerName} →
                  </Link>
                )}
              </div>

              <div className="no-print flex flex-wrap gap-2">
                {loan.status === 'draft' && (
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => changeStatus('active')}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    Activar préstamo
                  </button>
                )}
                {loan.status === 'active' && (
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={syncPenalties}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <RefreshIcon className="h-3.5 w-3.5" />
                    Sincronizar mora
                  </button>
                )}
                {isAdmin && loan.status === 'active' && (
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => changeStatus('blocked')}
                    className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                  >
                    Bloquear
                  </button>
                )}
                {isAdmin && loan.status === 'blocked' && (
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => changeStatus('active')}
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                  >
                    Reactivar
                  </button>
                )}
                {isAdmin &&
                  data.summary.billingMode === 'monthly_interest_only' &&
                  (loan.status === 'active' || loan.status === 'blocked') && (
                    <button
                      type="button"
                      onClick={() => setCapOpen(true)}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                    >
                      + Agregar capital
                    </button>
                  )}
                {isAdmin && (loan.status === 'active' || loan.status === 'blocked') && (
                  <button
                    type="button"
                    onClick={() => setAdjOpen(true)}
                    className="rounded-lg border border-slate-200 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    Ajuste administrativo
                  </button>
                )}
                {isAdmin && loan.status === 'finished' && (
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => changeStatus('archived')}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Archivar préstamo
                  </button>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <p className="text-xs text-slate-500">
                  {data.summary.billingMode === 'monthly_interest_only'
                    ? 'Capital vigente'
                    : 'Capital prestado'}
                </p>
                <p className="tabular-nums mt-1 text-lg font-bold text-slate-900">
                  {formatCOP(
                    data.summary.billingMode === 'monthly_interest_only'
                      ? (data.summary.currentCapital ?? loan.capital)
                      : loan.capital,
                  )}
                </p>
                {data.summary.billingMode === 'monthly_interest_only' && (
                  <p className="text-[11px] text-slate-400">
                    Desembolsado total: {formatCOP(loan.capital)}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500">
                  {data.summary.billingMode === 'monthly_interest_only'
                    ? `Cuota mensual (${loan.interest_rate}%/mes)`
                    : `Interés (${loan.interest_rate}%)`}
                </p>
                <p className="tabular-nums mt-1 text-lg font-bold text-slate-900">
                  {formatCOP(
                    data.summary.billingMode === 'monthly_interest_only'
                      ? Math.round(
                          ((data.summary.currentCapital ?? loan.capital) * loan.interest_rate) /
                            100,
                        )
                      : loan.contractual_interest,
                  )}
                </p>
                {data.summary.billingMode === 'monthly_interest_only' && (
                  <p className="text-[11px] text-slate-400">
                    Acumulado ciclos: {formatCOP(loan.contractual_interest)}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500">
                  {data.summary.billingMode === 'monthly_interest_only'
                    ? 'Esquema'
                    : 'Total pactado'}
                </p>
                <p className="tabular-nums mt-1 text-lg font-bold text-slate-900">
                  {data.summary.billingMode === 'monthly_interest_only'
                    ? 'Solo interés'
                    : formatCOP(loan.contractual_total)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Total abonado</p>
                <p className="tabular-nums mt-1 text-lg font-bold text-emerald-700">
                  {formatCOP(data.summary.totalPaid)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">
                  {data.summary.billingMode === 'monthly_interest_only'
                    ? 'Total para liquidar hoy'
                    : 'Saldo pendiente (+mora reg.)'}
                </p>
                <p className="tabular-nums mt-1 text-lg font-extrabold text-slate-900">
                  {formatCOP(data.summary.totalRemaining)}
                </p>
                {data.summary.estimatedPenaltiesPending > data.summary.recordedPenaltiesPending && (
                  <p className="text-[11px] text-rose-600">
                    Mora estimada por sincronizar:{' '}
                    {formatCOP(data.summary.estimatedPenaltiesPending)}
                  </p>
                )}
              </div>
            </div>

            {data.summary.billingMode === 'monthly_interest_only' ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
                <span>
                  Ciclo abierto mensual · <b>{data.summary.paidCount}</b> cuota(s) de interés
                  pagadas · Próxima cuota:{' '}
                  <b>
                    {formatCOP(
                      Math.round(
                        ((data.summary.currentCapital ?? loan.capital) * loan.interest_rate) / 100,
                      ),
                    )}
                  </b>
                </span>
                <span className="font-semibold text-emerald-700">
                  Capital vivo: {formatCOP(data.summary.currentCapital ?? loan.capital)}
                </span>
              </div>
            ) : (
              <div className="mt-5">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>
                    Avance: {data.summary.paidCount} de {data.summary.installmentsCount} cuotas
                    pagadas
                  </span>
                  <span className="font-semibold text-slate-800">{progressPct}%</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}
          </section>

          {/* Complete Installments Schedule */}
          <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <h2 className="text-base font-bold text-slate-900">
              Cronograma completo de cuotas ({data.installments.length})
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2.5 pr-3">#</th>
                    <th className="py-2.5 px-3">Programada</th>
                    <th className="py-2.5 px-3">Vence</th>
                    <th className="py-2.5 px-3 text-right">Valor</th>
                    <th className="py-2.5 px-3 text-right">Pagado</th>
                    <th className="py-2.5 px-3 text-right">Saldo</th>
                    <th className="py-2.5 px-3 text-right">Mora</th>
                    <th className="py-2.5 px-3">Estado</th>
                    {isAdmin && <th className="no-print py-2.5 pl-3 text-right">Control</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.installments.map((inst) => (
                    <tr key={inst.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-xs text-slate-500">
                        #{inst.installment_number}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">
                        {formatDateCO(inst.scheduled_due_date)}
                      </td>
                      <td className="py-2.5 px-3 text-xs font-medium text-slate-800">
                        {formatDateCO(inst.due_date)}
                        {inst.days_late > 0 && inst.effective_status !== 'paid' && (
                          <span className="ml-1.5 text-[11px] font-semibold text-rose-600">
                            ({inst.days_late}d háb. mora)
                          </span>
                        )}
                      </td>
                      <td className="tabular-nums py-2.5 px-3 text-right">
                        {formatCOP(inst.original_amount)}
                      </td>
                      <td className="tabular-nums py-2.5 px-3 text-right text-emerald-700">
                        {formatCOP(inst.paid_amount)}
                      </td>
                      <td className="tabular-nums py-2.5 px-3 text-right font-semibold text-slate-900">
                        {formatCOP(inst.remaining_amount)}
                      </td>
                      <td className="tabular-nums py-2.5 px-3 text-right text-xs">
                        {inst.estimated_penalties_remaining > 0 ? (
                          <span className="font-semibold text-rose-600">
                            {formatCOP(inst.estimated_penalties_remaining)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <InstallmentStatusBadge status={inst.effective_status} />
                        {inst.penalty_frozen && inst.effective_status !== 'paid' && (
                          <span className="ml-1.5 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                            Mora congelada
                          </span>
                        )}
                      </td>
                      {isAdmin && (
                        <td className="no-print py-2.5 pl-3 text-right">
                          {inst.effective_status !== 'paid' && (
                            <div className="inline-flex gap-1">
                              <button
                                type="button"
                                disabled={busyAction}
                                onClick={() => toggleFreeze(inst)}
                                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                              >
                                {inst.penalty_frozen ? 'Reactivar mora' : 'Congelar mora'}
                              </button>
                              {data.summary.billingMode === 'monthly_interest_only' && (
                                <button
                                  type="button"
                                  disabled={busyAction}
                                  onClick={() => handleCapitalizeInterest(inst)}
                                  className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                                >
                                  Capitalizar
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Payments, Adjustments & Regulatory Snapshot */}
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <h2 className="text-base font-bold text-slate-900">Pagos aplicados a este crédito</h2>
              <div className="mt-4 space-y-2.5">
                {data.payments.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm ${
                      p.reversed_at
                        ? 'border-rose-200 bg-rose-50/50 opacity-70'
                        : 'border-slate-100 bg-slate-50/70'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-slate-900">
                        {p.method === 'cash' ? 'Efectivo' : 'Transferencia'}
                        {p.transfer_reference && (
                          <span className="ml-2 font-mono text-xs text-slate-500">
                            Ref: {p.transfer_reference}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">{formatDateTimeCO(p.received_at)}</p>
                    </div>
                    <span
                      className={`tabular-nums font-bold ${
                        p.reversed_at ? 'line-through text-rose-600' : 'text-emerald-700'
                      }`}
                    >
                      {formatCOP(p.received_amount)}
                    </span>
                  </div>
                ))}
                {data.payments.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-400">
                    Aún no se han registrado pagos para este préstamo.
                  </p>
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <h2 className="text-base font-bold text-slate-900">
                Notas, ajustes y respaldo regulatorio
              </h2>
              {loan.notes && (
                <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
                  <b>Observaciones:</b> {loan.notes}
                </p>
              )}

              <div className="mt-4 space-y-2">
                {data.adjustments.map((adj) => (
                  <div
                    key={adj.id}
                    className="rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex justify-between font-semibold text-amber-950">
                      <span>{adj.adjustment_type}</span>
                      <span className="tabular-nums">{formatCOP(adj.amount)}</span>
                    </div>
                    <p className="mt-1 text-amber-900">{adj.reason}</p>
                    <p className="mt-0.5 text-[11px] text-amber-700">
                      {formatDateTimeCO(adj.created_at)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-600">
                <p className="font-semibold text-slate-800">Snapshot regulatorio al crear</p>
                <p className="mt-1">
                  Fuente: {String(loan.regulatory_snapshot?.official_source ?? 'No configurada')} ·
                  Tasa equiv. EA:{' '}
                  {String(loan.regulatory_snapshot?.loan_ea_equivalent ?? '—')}%
                </p>
              </div>
            </section>
          </div>

          {/* Add Capital Modal */}
          {capOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
              role="dialog"
              aria-modal="true"
            >
              <form
                onSubmit={submitAddCapital}
                className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
              >
                <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
                  <h3 className="text-base font-bold text-slate-900">
                    Agregar nuevo capital (Retanqueo)
                  </h3>
                  <button
                    type="button"
                    onClick={() => setCapOpen(false)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </div>
                <p className="mb-4 text-xs text-slate-600">
                  El nuevo capital se suma al saldo vigente ({formatCOP(data.summary.currentCapital ?? loan.capital)}) y ajusta automáticamente el interés ({loan.interest_rate}%/mes) de los próximos ciclos pendientes.
                </p>
                <div className="space-y-3.5">
                  <label>
                    Monto adicional entregado (COP)
                    <input
                      required
                      type="number"
                      min="1000"
                      step="1000"
                      value={capAmount}
                      onChange={(e) => setCapAmount(e.target.value)}
                      placeholder="Ej. 400000"
                    />
                  </label>
                  <label>
                    Motivo / Nota (obligatorio)
                    <input
                      required
                      minLength={3}
                      value={capReason}
                      onChange={(e) => setCapReason(e.target.value)}
                      placeholder="Ej. Ampliación de capital solicitada por el cliente"
                    />
                  </label>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCapOpen(false)}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={busyAction}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                  >
                    {busyAction ? 'Guardando…' : 'Confirmar retanqueo'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Adjustment Modal */}
          {adjOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
              role="dialog"
              aria-modal="true"
            >
              <form
                onSubmit={submitAdjustment}
                className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
              >
                <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
                  <h3 className="text-base font-bold text-slate-900">
                    Ajuste financiero (Administrador)
                  </h3>
                  <button
                    type="button"
                    onClick={() => setAdjOpen(false)}
                    className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-3.5">
                  <label>
                    Tipo de ajuste
                    <select
                      value={adjType}
                      onChange={(e) =>
                        setAdjType(
                          e.target.value as
                            | 'installment_discount'
                            | 'penalty_waiver'
                            | 'note_adjustment',
                        )
                      }
                    >
                      <option value="installment_discount">Descuento en valor de cuota</option>
                      <option value="penalty_waiver">Condonación de penalización / mora</option>
                      <option value="note_adjustment">Nota contable auditada</option>
                    </select>
                  </label>

                  {adjType === 'installment_discount' && (
                    <>
                      <label>
                        Cuota a descontar
                        <select
                          required
                          value={adjInstId}
                          onChange={(e) => setAdjInstId(e.target.value)}
                        >
                          <option value="">Selecciona una cuota pendiente</option>
                          {openInstallments.map((inst) => (
                            <option key={inst.id} value={inst.id}>
                              Cuota #{inst.installment_number} · Saldo{' '}
                              {formatCOP(inst.remaining_amount)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Valor del descuento (COP)
                        <input
                          required
                          type="number"
                          min="1"
                          value={adjAmount || ''}
                          onChange={(e) => setAdjAmount(Number(e.target.value))}
                        />
                      </label>
                    </>
                  )}

                  {adjType === 'penalty_waiver' && (
                    <>
                      <label>
                        Penalización registrada
                        <select
                          required
                          value={adjPenId}
                          onChange={(e) => setAdjPenId(e.target.value)}
                        >
                          <option value="">Selecciona una penalización pendiente</option>
                          {openPenalties.map((pen) => (
                            <option key={pen.id} value={pen.id}>
                              Cuota #{pen.installment_number} · Período {pen.period_number} ·{' '}
                              {formatCOP(Number(pen.amount) - Number(pen.paid_amount))}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Valor a condonar (0 = condonar todo)
                        <input
                          type="number"
                          min="0"
                          value={adjAmount}
                          onChange={(e) => setAdjAmount(Number(e.target.value))}
                        />
                      </label>
                    </>
                  )}

                  <label>
                    Motivo obligatorio (queda en auditoría)
                    <textarea
                      required
                      minLength={5}
                      rows={3}
                      value={adjReason}
                      onChange={(e) => setAdjReason(e.target.value)}
                      placeholder="Explica el acuerdo o justificación del ajuste…"
                    />
                  </label>
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAdjOpen(false)}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={busyAction}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
                  >
                    {busyAction ? 'Aplicando…' : 'Confirmar ajuste'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

export default function LoanDetailPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-slate-500">Cargando crédito…</p>}>
      <LoanDetailContent />
    </Suspense>
  );
}
