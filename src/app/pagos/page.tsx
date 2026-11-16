'use client';

import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useSessionInfo } from '@/components/app-shell';
import { CloseIcon, PrinterIcon, SearchIcon } from '@/components/icons';
import { ReceiptModal, type ReceiptData } from '@/components/receipt-modal';
import { InstallmentStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { autoAllocateWaterfall } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface CustomerOption {
  id: string;
  document_type: string;
  document_number: string;
  first_names: string;
  last_names: string;
  phone: string;
}

interface PendingInstallment {
  id: string;
  loan_id: string;
  installment_number: number;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  remaining_amount: number;
  effective_status: string;
  days_late: number;
}

interface PendingPenalty {
  id: string;
  installment_id: string;
  period_number: number;
  amount: number;
  paid_amount: number;
  remaining: number;
  installment_number: number;
  due_date: string;
}

interface PaymentHistoryItem {
  id: string;
  received_amount: number;
  method: 'cash' | 'transfer';
  transfer_reference: string | null;
  notes: string | null;
  received_at: string;
  reversed_at: string | null;
  collector_name: string;
  customer: CustomerOption | null;
  allocations: {
    id: string;
    installment_id: string | null;
    penalty_id: string | null;
    amount: number;
    installment: { installment_number: number; due_date: string } | null;
    penalty: { period_number: number } | null;
  }[];
}

function PagosContent() {
  const searchParams = useSearchParams();
  const { isAdmin, settings } = useSessionInfo();
  const { notify } = useToast();

  const initialCustomerId = searchParams.get('customerId') ?? '';
  const [tab, setTab] = useState<'register' | 'history'>('register');

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [installments, setInstallments] = useState<PendingInstallment[]>([]);
  const [penalties, setPenalties] = useState<PendingPenalty[]>([]);
  const [instValues, setInstValues] = useState<Record<string, string>>({});
  const [penValues, setPenValues] = useState<Record<string, string>>({});
  const [lumpSum, setLumpSum] = useState('');
  const [method, setMethod] = useState<'cash' | 'transfer'>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // History
  const [history, setHistory] = useState<PaymentHistoryItem[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  // Reversal modal
  const [reverseTarget, setReverseTarget] = useState<PaymentHistoryItem | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reversing, setReversing] = useState(false);

  const loadCustomerDebts = useCallback(async (cid: string) => {
    setInstValues({});
    setPenValues({});
    if (!cid) {
      setInstallments([]);
      setPenalties([]);
      return;
    }
    const res = await fetch(`/api/installments?customerId=${cid}&onlyUnpaid=true`, {
      cache: 'no-store',
    });
    const json = await res.json();
    if (res.ok) {
      setInstallments(json.installments ?? []);
      setPenalties(json.penalties ?? []);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch('/api/payments?limit=150', { cache: 'no-store' });
    const json = await res.json();
    if (res.ok) setHistory(json.payments ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      const [custRes] = await Promise.all([
        fetch('/api/customers?includeArchived=false', { cache: 'no-store' }),
        loadHistory(),
      ]);
      const custJson = await custRes.json();
      if (custRes.ok) setCustomers(custJson.customers ?? []);
      if (initialCustomerId) {
        await loadCustomerDebts(initialCustomerId);
      }
    })();
  }, [initialCustomerId, loadCustomerDebts, loadHistory]);

  function handleCustomerChange(cid: string) {
    setCustomerId(cid);
    setFormError('');
    setLumpSum('');
    void loadCustomerDebts(cid);
  }

  function handleWaterfall() {
    const amt = Math.max(0, Math.round(Number(lumpSum) || 0));
    if (amt <= 0) {
      notify('Ingresa un valor recibido para distribuir.', 'error');
      return;
    }
    const { penaltyMap, installmentMap, unallocated } = autoAllocateWaterfall(
      amt,
      installments.map((i) => ({
        id: i.id,
        due_date: i.due_date,
        installment_number: i.installment_number,
        remaining: i.remaining_amount,
      })),
      penalties.map((p) => ({
        id: p.id,
        installment_id: p.installment_id,
        period_number: p.period_number,
        remaining: p.remaining,
      })),
    );
    const nextInst: Record<string, string> = {};
    for (const [k, v] of Object.entries(installmentMap)) nextInst[k] = String(v);
    const nextPen: Record<string, string> = {};
    for (const [k, v] of Object.entries(penaltyMap)) nextPen[k] = String(v);
    setInstValues(nextInst);
    setPenValues(nextPen);
    if (unallocated > 0) {
      notify(
        `Se asignaron ${formatCOP(amt - unallocated)}. Sobran ${formatCOP(unallocated)} por encima de la deuda actual.`,
        'info',
      );
    }
  }

  const totalInst = Object.values(instValues).reduce((s, v) => s + (Math.round(Number(v)) || 0), 0);
  const totalPen = Object.values(penValues).reduce((s, v) => s + (Math.round(Number(v)) || 0), 0);
  const totalAllocated = totalInst + totalPen;
  const totalCustomerDebt =
    installments.reduce((s, i) => s + i.remaining_amount, 0) +
    penalties.reduce((s, p) => s + p.remaining, 0);

  async function submitPayment(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!customerId || totalAllocated <= 0) {
      setFormError('Selecciona un cliente y asigna al menos un valor mayor a 0.');
      return;
    }
    if (method === 'transfer' && !reference.trim()) {
      setFormError('La referencia de transferencia es obligatoria.');
      return;
    }

    const installment_allocations = Object.entries(instValues)
      .filter(([, v]) => Math.round(Number(v)) > 0)
      .map(([installment_id, v]) => ({
        installment_id,
        amount: Math.round(Number(v)),
      }));

    const penalty_allocations = Object.entries(penValues)
      .filter(([, v]) => Math.round(Number(v)) > 0)
      .map(([penalty_id, v]) => ({
        penalty_id,
        amount: Math.round(Number(v)),
      }));

    setSaving(true);
    try {
      const res = await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          method,
          transfer_reference: method === 'transfer' ? reference.trim() : null,
          notes: notes.trim() || null,
          idempotency_key: crypto.randomUUID(),
          installment_allocations,
          penalty_allocations,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error ?? 'Error al registrar el pago');
        return;
      }

      notify(
        json.finished_loans?.length
          ? 'Pago registrado y préstamo saldado al 100%.'
          : 'Pago registrado y auditado correctamente.',
        'success',
      );

      const instLookup = new Map(installments.map((i) => [i.id, i]));
      const penLookup = new Map(penalties.map((p) => [p.id, p]));
      setReceipt({
        id: json.payment.id,
        received_amount: json.payment.received_amount,
        method: json.payment.method,
        transfer_reference: json.payment.transfer_reference,
        received_at: json.payment.received_at,
        customer: json.customer,
        business_profile: json.business_profile,
        allocations: (json.allocations ?? []).map(
          (a: { id: string; installment_id?: string; penalty_id?: string; amount: number }) => {
            const inst = a.installment_id ? instLookup.get(a.installment_id) : null;
            const pen = a.penalty_id ? penLookup.get(a.penalty_id) : null;
            return {
              ...a,
              label: inst
                ? `Cuota #${inst.installment_number} (${formatDateCO(inst.due_date)})`
                : pen
                  ? `Mora cuota #${pen.installment_number} (P${pen.period_number})`
                  : 'Abono',
            };
          },
        ),
      });

      setReference('');
      setNotes('');
      setLumpSum('');
      await Promise.all([loadCustomerDebts(customerId), loadHistory()]);
    } catch {
      setFormError('Error de red al confirmar el pago.');
    } finally {
      setSaving(false);
    }
  }

  async function submitReverse(e: FormEvent) {
    e.preventDefault();
    if (!reverseTarget) return;
    setReversing(true);
    try {
      const res = await fetch(`/api/payments/${reverseTarget.id}/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reverseReason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error al reversar');
      notify('Pago reversado y saldos restaurados correctamente.', 'success');
      setReverseTarget(null);
      setReverseReason('');
      await Promise.all([loadHistory(), customerId ? loadCustomerDebts(customerId) : Promise.resolve()]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setReversing(false);
    }
  }

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((p) => {
      const text = `${p.customer?.first_names ?? ''} ${p.customer?.last_names ?? ''} ${
        p.customer?.document_number ?? ''
      } ${p.transfer_reference ?? ''} ${p.id}`.toLowerCase();
      return text.includes(q);
    });
  }, [history, historySearch]);

  return (
    <>
      <div className="mb-5 inline-flex rounded-xl border border-slate-200 bg-white p-1">
        <button
          type="button"
          onClick={() => setTab('register')}
          className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
            tab === 'register' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Registrar pago
        </button>
        <button
          type="button"
          onClick={() => setTab('history')}
          className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
            tab === 'history' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Historial de pagos ({history.length})
        </button>
      </div>

      {tab === 'register' ? (
        <form onSubmit={submitPayment} className="grid gap-6 lg:grid-cols-3">
          <section className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2">
                Cliente
                <select
                  required
                  value={customerId}
                  onChange={(e) => handleCustomerChange(e.target.value)}
                >
                  <option value="">Seleccione un cliente</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.first_names} {c.last_names} · {c.document_number}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Método de recaudo
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as 'cash' | 'transfer')}
                >
                  <option value="cash">Efectivo</option>
                  <option value="transfer">Transferencia</option>
                </select>
              </label>

              {method === 'transfer' ? (
                <label>
                  Referencia de transferencia
                  <input
                    required
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Comprobante / Nequi / Bancolombia"
                  />
                </label>
              ) : (
                <label>
                  Notas (opcional)
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Observaciones del recaudo"
                  />
                </label>
              )}
            </div>

            {/* Waterfall Auto-allocator */}
            {customerId && (installments.length > 0 || penalties.length > 0) && (
              <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5">
                <label className="min-w-48 flex-1 text-xs text-emerald-950">
                  Distribución rápida en cascada (monto entregado por cliente)
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={lumpSum}
                    onChange={(e) => setLumpSum(e.target.value)}
                    placeholder="Ej. 50000"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleWaterfall}
                  className="rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  Distribuir automático
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInstValues({});
                    setPenValues({});
                    setLumpSum('');
                  }}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Limpiar
                </button>
              </div>
            )}

            {/* Open Penalties */}
            {penalties.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-bold uppercase tracking-wide text-rose-700">
                  Penalizaciones por mora registradas
                </h3>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-rose-200 text-xs text-rose-700">
                      <tr>
                        <th className="py-2 pr-3">Cuota / Período</th>
                        <th className="py-2 px-3 text-right">Saldo mora</th>
                        <th className="py-2 pl-3">Asignar (COP)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {penalties.map((pen) => (
                        <tr key={pen.id} className="border-b border-rose-100">
                          <td className="py-2.5 pr-3 text-xs">
                            Cuota #{pen.installment_number} · Período {pen.period_number}
                          </td>
                          <td className="tabular-nums py-2.5 px-3 text-right font-semibold text-rose-700">
                            {formatCOP(pen.remaining)}
                          </td>
                          <td className="py-2.5 pl-3">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min="0"
                                max={pen.remaining}
                                value={penValues[pen.id] ?? ''}
                                onChange={(e) =>
                                  setPenValues({ ...penValues, [pen.id]: e.target.value })
                                }
                                className="min-w-28"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setPenValues({ ...penValues, [pen.id]: String(pen.remaining) })
                                }
                                className="shrink-0 rounded-lg border border-rose-200 px-2 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
                              >
                                Todo
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Open Installments */}
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2.5 pr-3">Cuota</th>
                    <th className="py-2.5 px-3">Vence</th>
                    <th className="py-2.5 px-3">Estado</th>
                    <th className="py-2.5 px-3 text-right">Saldo</th>
                    <th className="py-2.5 pl-3">Asignar (COP)</th>
                  </tr>
                </thead>
                <tbody>
                  {installments.map((inst) => (
                    <tr key={inst.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-slate-800">
                        #{inst.installment_number}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-600">
                        {formatDateCO(inst.due_date)}
                        {inst.days_late > 0 && (
                          <span className="ml-1.5 text-rose-600">({inst.days_late}d)</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <InstallmentStatusBadge status={inst.effective_status} />
                      </td>
                      <td className="tabular-nums py-2.5 px-3 text-right font-semibold text-slate-900">
                        {formatCOP(inst.remaining_amount)}
                      </td>
                      <td className="py-2.5 pl-3">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min="0"
                            max={inst.remaining_amount}
                            value={instValues[inst.id] ?? ''}
                            onChange={(e) =>
                              setInstValues({ ...instValues, [inst.id]: e.target.value })
                            }
                            className="min-w-28"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setInstValues({
                                ...instValues,
                                [inst.id]: String(inst.remaining_amount),
                              })
                            }
                            className="shrink-0 rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Todo
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {customerId && installments.length === 0 && penalties.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                        Este cliente no tiene cuotas ni penalizaciones pendientes.
                      </td>
                    </tr>
                  )}
                  {!customerId && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                        Selecciona un cliente arriba para cargar sus cuotas pendientes.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {formError && (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700"
              >
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={saving || totalAllocated <= 0}
              className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-xs hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {saving ? 'Registrando pago…' : `Confirmar pago de ${formatCOP(totalAllocated)}`}
            </button>
          </section>

          <aside className="flex flex-col justify-between rounded-2xl bg-slate-950 p-6 text-white shadow-xs">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Total a confirmar
              </p>
              <p className="tabular-nums mt-2 text-3xl font-extrabold text-emerald-400">
                {formatCOP(totalAllocated)}
              </p>

              <dl className="mt-6 space-y-3 border-t border-slate-800 pt-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-400">Aplicado a cuotas</dt>
                  <dd className="tabular-nums font-medium">{formatCOP(totalInst)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Aplicado a moras</dt>
                  <dd className="tabular-nums font-medium">{formatCOP(totalPen)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Deuda actual cliente</dt>
                  <dd className="tabular-nums font-medium">{formatCOP(totalCustomerDebt)}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-800 pt-3">
                  <dt className="text-slate-400">Saldo tras este pago</dt>
                  <dd className="tabular-nums font-bold text-white">
                    {formatCOP(Math.max(0, totalCustomerDebt - totalAllocated))}
                  </dd>
                </div>
              </dl>
            </div>

            <p className="mt-6 text-xs leading-relaxed text-slate-400">
              Cada pago genera un comprobante imprimible y compartible por WhatsApp, con llave de
              idempotencia y auditoría inmutable.
            </p>
          </aside>
        </form>
      ) : (
        <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold text-slate-900">Historial de recaudos</h2>
            <div className="relative min-w-64 flex-1 sm:max-w-xs">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Buscar por cliente, doc o ref…"
                className="pl-9"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2.5 pr-3">Fecha y hora</th>
                  <th className="py-2.5 px-3">Cliente</th>
                  <th className="py-2.5 px-3">Medio / Ref</th>
                  <th className="py-2.5 px-3">Recaudador</th>
                  <th className="py-2.5 px-3 text-right">Valor</th>
                  <th className="py-2.5 pl-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((pay) => (
                  <tr
                    key={pay.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      pay.reversed_at ? 'bg-rose-50/40 opacity-75' : ''
                    }`}
                  >
                    <td className="py-3 pr-3 text-xs text-slate-600">
                      <p>{formatDateTimeCO(pay.received_at)}</p>
                      <p className="font-mono text-[11px] text-slate-400">
                        #{pay.id.slice(0, 8).toUpperCase()}
                      </p>
                    </td>
                    <td className="py-3 px-3">
                      <p className="font-semibold text-slate-900">
                        {pay.customer
                          ? `${pay.customer.first_names} ${pay.customer.last_names}`
                          : 'Cliente'}
                      </p>
                      <p className="text-xs text-slate-500">
                        {pay.allocations.length} asignación(es)
                      </p>
                    </td>
                    <td className="py-3 px-3 text-xs">
                      <span className="font-medium text-slate-800">
                        {pay.method === 'cash' ? 'Efectivo' : 'Transferencia'}
                      </span>
                      {pay.transfer_reference && (
                        <p className="font-mono text-slate-500">{pay.transfer_reference}</p>
                      )}
                      {pay.reversed_at && (
                        <span className="mt-1 inline-block rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                          REVERSADO
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-600">{pay.collector_name}</td>
                    <td
                      className={`tabular-nums py-3 px-3 text-right font-bold ${
                        pay.reversed_at ? 'line-through text-rose-600' : 'text-emerald-700'
                      }`}
                    >
                      {formatCOP(pay.received_amount)}
                    </td>
                    <td className="py-3 pl-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setReceipt({
                              id: pay.id,
                              received_amount: pay.received_amount,
                              method: pay.method,
                              transfer_reference: pay.transfer_reference,
                              received_at: pay.received_at,
                              customer: pay.customer,
                              business_profile: settings.business_profile,
                              allocations: pay.allocations.map((a) => ({
                                id: a.id,
                                installment_id: a.installment_id,
                                penalty_id: a.penalty_id,
                                amount: a.amount,
                                label: a.installment
                                  ? `Cuota #${a.installment.installment_number} (${formatDateCO(a.installment.due_date)})`
                                  : a.penalty
                                    ? `Penalización período ${a.penalty.period_number}`
                                    : 'Abono',
                              })),
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <PrinterIcon className="h-3.5 w-3.5" />
                          Comprobante
                        </button>
                        {isAdmin && !pay.reversed_at && (
                          <button
                            type="button"
                            onClick={() => {
                              setReverseTarget(pay);
                              setReverseReason('');
                            }}
                            className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                          >
                            Reversar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredHistory.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-sm text-slate-400">
                      No hay pagos registrados todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Reversal Modal */}
      {reverseTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={submitReverse}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-rose-700">Reversar pago (Administrador)</h3>
              <button
                type="button"
                onClick={() => setReverseTarget(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Se revertirá el ingreso de{' '}
              <b>{formatCOP(reverseTarget.received_amount)}</b> y se restaurarán los saldos de las
              cuotas afectadas. El registro original permanecerá visible como reversado.
            </p>
            <label className="mt-4">
              Motivo obligatorio de reversión
              <textarea
                required
                minLength={5}
                rows={3}
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                placeholder="Ej. Transferencia rechazada / error de digitación…"
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReverseTarget(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={reversing}
                className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:bg-slate-300"
              >
                {reversing ? 'Reversando…' : 'Confirmar reversión'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />
    </>
  );
}

export default function PagosPage() {
  return (
    <AppShell
      title="Pagos y Recaudos"
      subtitle="Distribución en cascada o manual, recibos por WhatsApp e historial auditado"
    >
      <Suspense fallback={<p className="text-sm text-slate-500">Cargando módulo de pagos…</p>}>
        <PagosContent />
      </Suspense>
    </AppShell>
  );
}
