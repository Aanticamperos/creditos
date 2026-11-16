'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { CloseIcon, RefreshIcon, SearchIcon, WhatsAppIcon } from '@/components/icons';
import { ReceiptModal, type ReceiptData } from '@/components/receipt-modal';
import { InstallmentStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO } from '@/lib/dates';
import { buildWhatsAppUrl, FREQUENCY_LABELS, type Frequency } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface QueueInstallment {
  id: string;
  loan_id: string;
  installment_number: number;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  effective_status: string;
  remaining_amount: number;
  days_late: number;
  recorded_penalties_remaining: number;
  estimated_penalties_remaining: number;
  penalties: { id: string; period_number: number; amount: number; paid_amount: number }[];
  loan: {
    id: string;
    frequency: Frequency;
    installments_count: number;
    status: string;
  };
  customer: {
    id: string;
    document_type: string;
    document_number: string;
    first_names: string;
    last_names: string;
    phone: string;
  } | null;
}

type Bucket = 'today' | 'overdue' | 'partial' | 'upcoming' | 'paid' | 'all';

export default function CuotasPage() {
  const { notify } = useToast();
  const [items, setItems] = useState<QueueInstallment[]>([]);
  const [today, setToday] = useState('');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [bucket, setBucket] = useState<Bucket>('today');
  const [search, setSearch] = useState('');

  // Quick pay modal state
  const [payTarget, setPayTarget] = useState<QueueInstallment | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [includePenalties, setIncludePenalties] = useState(true);
  const [payMethod, setPayMethod] = useState<'cash' | 'transfer'>('cash');
  const [payRef, setPayRef] = useState('');
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/installments?bucket=all', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando cuotas');
      setItems(json.installments ?? []);
      setToday(json.today ?? '');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
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

  const counts = useMemo(() => {
    let todayC = 0;
    let overdueC = 0;
    let partialC = 0;
    let upcomingC = 0;
    let paidC = 0;
    for (const i of items) {
      if (i.effective_status === 'paid') paidC++;
      else {
        if (i.due_date === today) todayC++;
        if (i.effective_status === 'overdue' || i.effective_status === 'overdue_partial') overdueC++;
        if (i.effective_status === 'partial' || i.effective_status === 'overdue_partial') partialC++;
        if (i.due_date > today) upcomingC++;
      }
    }
    return {
      today: todayC,
      overdue: overdueC,
      partial: partialC,
      upcoming: upcomingC,
      paid: paidC,
      all: items.length,
    };
  }, [items, today]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (bucket === 'today' && !(i.due_date === today && i.effective_status !== 'paid')) {
        return false;
      }
      if (
        bucket === 'overdue' &&
        i.effective_status !== 'overdue' &&
        i.effective_status !== 'overdue_partial'
      ) {
        return false;
      }
      if (
        bucket === 'partial' &&
        i.effective_status !== 'partial' &&
        i.effective_status !== 'overdue_partial'
      ) {
        return false;
      }
      if (bucket === 'upcoming' && !(i.due_date > today && i.effective_status !== 'paid')) {
        return false;
      }
      if (bucket === 'paid' && i.effective_status !== 'paid') {
        return false;
      }
      if (!q) return true;
      const text = i.customer
        ? `${i.customer.first_names} ${i.customer.last_names} ${i.customer.document_number} ${i.customer.phone}`.toLowerCase()
        : '';
      return text.includes(q);
    });
  }, [bucket, items, search, today]);

  async function syncPenalties() {
    setSyncing(true);
    try {
      const res = await fetch('/api/penalties/sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error sincronizando');
      notify(
        `Sincronización completada: ${json.updatedInstallments} cuotas vencidas y ${json.createdPenalties} penalizaciones nuevas.`,
        'success',
      );
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setSyncing(false);
    }
  }

  function openQuickPay(item: QueueInstallment) {
    setPayTarget(item);
    setIncludePenalties(item.recorded_penalties_remaining > 0);
    setPayAmount(item.remaining_amount);
    setPayMethod('cash');
    setPayRef('');
  }

  async function submitQuickPay(e: FormEvent) {
    e.preventDefault();
    if (!payTarget || !payTarget.customer) return;
    if (payMethod === 'transfer' && !payRef.trim()) {
      notify('La referencia es obligatoria para transferencias.', 'error');
      return;
    }

    const validInstAmt = Math.min(Math.max(0, Math.round(payAmount)), payTarget.remaining_amount);
    const penAllocs = includePenalties
      ? payTarget.penalties
          .filter((p) => Number(p.amount) > Number(p.paid_amount))
          .map((p) => ({
            penalty_id: p.id,
            amount: Number(p.amount) - Number(p.paid_amount),
          }))
      : [];

    if (validInstAmt <= 0 && penAllocs.length === 0) {
      notify('Ingresa un valor positivo a cobrar.', 'error');
      return;
    }

    setPaying(true);
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: payTarget.customer.id,
          method: payMethod,
          transfer_reference: payMethod === 'transfer' ? payRef.trim() : null,
          idempotency_key: crypto.randomUUID(),
          installment_allocations:
            validInstAmt > 0 ? [{ installment_id: payTarget.id, amount: validInstAmt }] : [],
          penalty_allocations: penAllocs,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error al registrar cobro');

      notify('Cobro registrado correctamente.', 'success');
      setReceipt({
        id: json.payment.id,
        received_amount: json.payment.received_amount,
        method: json.payment.method,
        transfer_reference: json.payment.transfer_reference,
        received_at: json.payment.received_at,
        customer: json.customer,
        business_profile: json.business_profile,
        allocations: (json.allocations ?? []).map(
          (a: { id: string; installment_id?: string; penalty_id?: string; amount: number }) => ({
            ...a,
            label: a.penalty_id
              ? `Penalización cuota #${payTarget.installment_number}`
              : `Cuota #${payTarget.installment_number}`,
          }),
        ),
      });
      setPayTarget(null);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error al registrar pago', 'error');
    } finally {
      setPaying(false);
    }
  }

  return (
    <AppShell
      title="Cobranza y Cuotas"
      subtitle={today ? `Agenda operativa del ${formatDateCO(today)}` : 'Agenda de cobro'}
      actions={
        <button
          type="button"
          onClick={syncPenalties}
          disabled={syncing}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshIcon className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando…' : 'Sincronizar estados y moras'}
        </button>
      }
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['today', `Para hoy (${counts.today})`],
              ['overdue', `Vencidas (${counts.overdue})`],
              ['partial', `Parciales (${counts.partial})`],
              ['upcoming', `Próximas (${counts.upcoming})`],
              ['paid', `Pagadas (${counts.paid})`],
              ['all', `Todas (${counts.all})`],
            ] as [Bucket, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setBucket(key)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                bucket === key
                  ? key === 'overdue'
                    ? 'bg-rose-600 text-white'
                    : 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative min-w-60 flex-1 sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar por cliente o documento…"
            className="pl-9"
          />
        </div>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Cuota</th>
                <th className="px-4 py-3">Vencimiento</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Saldo cuota</th>
                <th className="px-4 py-3 text-right">Mora</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const custName = item.customer
                  ? `${item.customer.first_names} ${item.customer.last_names}`
                  : 'Cliente';
                const totalDue = item.remaining_amount + item.estimated_penalties_remaining;
                const waMsg = [
                  `Hola ${item.customer?.first_names ?? ''},`,
                  `te recordamos tu cuota #${item.installment_number}/${item.loan.installments_count} con vencimiento ${formatDateCO(item.due_date)}.`,
                  `Saldo pendiente: *${formatCOP(totalDue)}*${
                    item.days_late > 0 ? ` (${item.days_late} días hábiles en mora)` : ''
                  }.`,
                ].join(' ');
                const waUrl = buildWhatsAppUrl(item.customer?.phone, waMsg);

                return (
                  <tr key={item.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      {item.customer ? (
                        <Link
                          href={`/clientes/${item.customer.id}`}
                          className="font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
                        >
                          {custName}
                        </Link>
                      ) : (
                        custName
                      )}
                      <p className="text-xs text-slate-500">{item.customer?.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Link
                        href={`/prestamos/${item.loan_id}`}
                        className="font-mono font-semibold text-slate-800 hover:underline"
                      >
                        #{item.installment_number}/{item.loan.installments_count}
                      </Link>
                      <p className="text-slate-500">
                        {FREQUENCY_LABELS[item.loan.frequency] ?? item.loan.frequency}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p className="font-medium text-slate-800">{formatDateCO(item.due_date)}</p>
                      {item.days_late > 0 && item.effective_status !== 'paid' && (
                        <p className="font-semibold text-rose-600">
                          {item.days_late} día(s) háb. atraso
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <InstallmentStatusBadge status={item.effective_status} />
                    </td>
                    <td className="tabular-nums px-4 py-3 text-right font-semibold text-slate-900">
                      {formatCOP(item.remaining_amount)}
                    </td>
                    <td className="tabular-nums px-4 py-3 text-right text-xs">
                      {item.estimated_penalties_remaining > 0 ? (
                        <div>
                          <span className="font-semibold text-rose-600">
                            {formatCOP(item.estimated_penalties_remaining)}
                          </span>
                          {item.estimated_penalties_remaining > item.recorded_penalties_remaining && (
                            <p className="text-[10px] text-slate-400">Requiere sync</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {waUrl && item.effective_status !== 'paid' && (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Cobrar por WhatsApp"
                            className="rounded-lg border border-emerald-200 bg-emerald-50 p-1.5 text-emerald-700 hover:bg-emerald-100"
                          >
                            <WhatsAppIcon className="h-3.5 w-3.5" />
                          </a>
                        )}
                        {item.effective_status !== 'paid' && (
                          <button
                            type="button"
                            onClick={() => openQuickPay(item)}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            Cobrar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-400">
                    No hay cuotas en esta categoría.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Quick Collect Modal */}
      {payTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={submitQuickPay}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Cobro rápido · Cuota #{payTarget.installment_number}
                </h3>
                <p className="text-xs text-slate-500">
                  {payTarget.customer?.first_names} {payTarget.customer?.last_names}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPayTarget(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <label>
                Valor a abonar a la cuota (máx. {formatCOP(payTarget.remaining_amount)})
                <input
                  type="number"
                  min="0"
                  max={payTarget.remaining_amount}
                  value={payAmount || ''}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                />
              </label>

              {payTarget.recorded_penalties_remaining > 0 && (
                <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-900">
                  <input
                    type="checkbox"
                    checked={includePenalties}
                    onChange={(e) => setIncludePenalties(e.target.checked)}
                    className="h-4 w-4 accent-rose-600"
                  />
                  Incluir penalizaciones registradas ({formatCOP(payTarget.recorded_penalties_remaining)})
                </label>
              )}

              <label>
                Método de pago
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as 'cash' | 'transfer')}
                >
                  <option value="cash">Efectivo</option>
                  <option value="transfer">Transferencia</option>
                </select>
              </label>

              {payMethod === 'transfer' && (
                <label>
                  Referencia de transferencia
                  <input
                    required
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    placeholder="Nequi / Bancolombia / Comprobante"
                  />
                </label>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
              <div>
                <p className="text-xs text-slate-500">Total a confirmar</p>
                <p className="tabular-nums text-lg font-extrabold text-emerald-700">
                  {formatCOP(
                    Math.min(payAmount || 0, payTarget.remaining_amount) +
                      (includePenalties ? payTarget.recorded_penalties_remaining : 0),
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPayTarget(null)}
                  className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-700"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={paying}
                  className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                >
                  {paying ? 'Registrando…' : 'Confirmar pago'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />
    </AppShell>
  );
}
