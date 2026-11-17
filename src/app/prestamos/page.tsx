'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useSessionInfo } from '@/components/app-shell';
import { AlertIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { LoanStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO, nextCalendarMonthDate, todayBogota } from '@/lib/dates';
import {
  computeEquivalentRates,
  FREQUENCY_LABELS,
  quote,
  schedule,
  shiftToWorkingDay,
  type BillingMode,
  type Frequency,
} from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface LoanItem {
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
  status: string;
  customer: {
    id: string;
    document_type: string;
    document_number: string;
    first_names: string;
    last_names: string;
    phone: string;
  } | null;
  total_paid: number;
  billing_mode?: BillingMode;
  current_capital?: number;
  installments_remaining: number;
  penalties_remaining: number;
  total_remaining?: number;
  overdue_count: number;
  paid_count: number;
  next_due_date: string | null;
}

interface CustomerOption {
  id: string;
  first_names: string;
  last_names: string;
  document_number: string;
}

const CAPITAL_PRESETS = [100_000, 200_000, 500_000, 1_000_000, 2_000_000];

function PrestamosContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { settings } = useSessionInfo();
  const { notify } = useToast();

  const initialTab =
    searchParams.get('nuevo') === '1' || Boolean(searchParams.get('customerId'))
      ? 'new'
      : 'list';

  const [tab, setTab] = useState<'list' | 'new'>(initialTab);
  const [loans, setLoans] = useState<LoanItem[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [holidays, setHolidays] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  // New Loan Form State
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') ?? '');
  const [billingMode, setBillingMode] = useState<BillingMode>('fixed_installments');
  const [capital, setCapital] = useState(300_000);
  const [rateInput, setRateInput] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [count, setCount] = useState(20);
  const [disbursementDate, setDisbursementDate] = useState('');
  const [firstPaymentDate, setFirstPaymentDate] = useState('');
  const [initialStatus, setInitialStatus] = useState<'active' | 'draft'>('active');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [loansRes, custRes, holRes] = await Promise.all([
        fetch('/api/loans?status=all', { cache: 'no-store' }),
        fetch('/api/customers?includeArchived=false', { cache: 'no-store' }),
        fetch('/api/holidays', { cache: 'no-store' }),
      ]);
      const [loansJson, custJson, holJson] = await Promise.all([
        loansRes.json(),
        custRes.json(),
        holRes.json(),
      ]);
      if (loansRes.ok) setLoans(loansJson.loans ?? []);
      if (custRes.ok) setCustomers(custJson.customers ?? []);
      if (holRes.ok) {
        setHolidays((holJson.holidays ?? []).map((h: { holiday_date: string }) => h.holiday_date));
      }
    } catch {
      notify('Error cargando datos de préstamos.', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const t = todayBogota();
      setDisbursementDate((prev) => prev || t);
      setFirstPaymentDate((prev) => prev || t);
      void loadAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);

  const filteredLoans = useMemo(() => {
    const q = search.trim().toLowerCase();
    return loans.filter((l) => {
      if (statusFilter !== 'all' && l.status !== statusFilter) return false;
      if (!q) return true;
      const custName = l.customer
        ? `${l.customer.first_names} ${l.customer.last_names} ${l.customer.document_number}`.toLowerCase()
        : '';
      return custName.includes(q) || l.id.toLowerCase().includes(q);
    });
  }, [loans, search, statusFilter]);

  const parsedRate = rateInput.trim() === '' ? 0 : Number(rateInput);
  const safeCapital = Number.isInteger(capital) && capital > 0 ? capital : 1;
  const safeRate = Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : 0;
  const isMonthlyInterestOnly = billingMode === 'monthly_interest_only';
  const safeCount = isMonthlyInterestOnly
    ? 1
    : Number.isInteger(count) && count >= 1
      ? Math.min(count, 365)
      : 1;

  const q = useMemo(() => {
    if (isMonthlyInterestOnly) {
      const interest = Math.round((safeCapital * safeRate) / 100);
      return { interest, total: safeCapital + interest, values: [interest] };
    }
    return quote(safeCapital, safeRate, safeCount);
  }, [isMonthlyInterestOnly, safeCapital, safeRate, safeCount]);

  const dates = useMemo(() => {
    if (!firstPaymentDate) return [];
    if (isMonthlyInterestOnly) {
      const billingDay = Number(firstPaymentDate.slice(8, 10)) || 1;
      const preview: { scheduled: string; due: string }[] = [];
      let sched = firstPaymentDate;
      for (let i = 0; i < 3; i++) {
        preview.push({ scheduled: sched, due: shiftToWorkingDay(sched, holidays) });
        sched = nextCalendarMonthDate(sched, billingDay);
      }
      return preview;
    }
    return schedule(firstPaymentDate, frequency, safeCount, holidays);
  }, [firstPaymentDate, frequency, holidays, isMonthlyInterestOnly, safeCount]);

  const equivalent = useMemo(
    () =>
      computeEquivalentRates(
        safeRate,
        isMonthlyInterestOnly ? 'monthly' : frequency,
        isMonthlyInterestOnly ? 1 : safeCount,
      ),
    [frequency, isMonthlyInterestOnly, safeCount, safeRate],
  );

  const reg = settings.regulatory_policy;
  const exceedsRegulatory =
    reg.configured && reg.max_ea_rate > 0 && equivalent.eaEquivalent > reg.max_ea_rate;

  async function handleCreateLoan(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!customerId) {
      setFormError('Selecciona un cliente.');
      return;
    }
    if (rateInput.trim() === '' || !Number.isFinite(parsedRate) || parsedRate < 0) {
      setFormError('Ingresa la tasa de interés (%) que deseas aplicar a este préstamo.');
      return;
    }
    if (isMonthlyInterestOnly && parsedRate <= 0) {
      setFormError('La modalidad mensual solo interés requiere una tasa mayor a 0%.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          capital: safeCapital,
          interest_rate: safeRate,
          frequency: isMonthlyInterestOnly ? 'monthly' : frequency,
          billing_mode: billingMode,
          installments_count: safeCount,
          disbursement_date: disbursementDate,
          first_payment_date: firstPaymentDate,
          notes: notes || null,
          initial_status: initialStatus,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error ?? 'No fue posible crear el préstamo.');
        return;
      }
      notify('Préstamo y calendario de cuotas creados correctamente.', 'success');
      router.push(`/prestamos/${json.loan.id}`);
    } catch {
      setFormError('Error de red al guardar el préstamo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
              tab === 'list' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Cartera de préstamos ({loans.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('new')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition ${
              tab === 'new' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Nuevo préstamo
          </button>
        </div>
      </div>

      {tab === 'list' ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-64 flex-1 sm:max-w-sm">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por cliente o documento…"
                className="pl-9"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[
                ['all', 'Todos'],
                ['active', 'Activos'],
                ['draft', 'Borradores'],
                ['blocked', 'Bloqueados'],
                ['finished', 'Finalizados'],
                ['archived', 'Archivados'],
              ].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setStatusFilter(val)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    statusFilter === val
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50/70 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Cliente</th>
                    <th className="px-4 py-3">Condiciones</th>
                    <th className="px-4 py-3 text-right">Capital</th>
                    <th className="px-4 py-3 text-right">Total pactado</th>
                    <th className="px-4 py-3">Progreso</th>
                    <th className="px-4 py-3 text-right">Saldo pendiente</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLoans.map((loan) => {
                    const pct =
                      loan.contractual_total > 0
                        ? Math.min(100, Math.round((loan.total_paid / loan.contractual_total) * 100))
                        : 0;
                    const custName = loan.customer
                      ? `${loan.customer.first_names} ${loan.customer.last_names}`
                      : 'Cliente';
                    return (
                      <tr key={loan.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3">
                          <Link
                            href={`/prestamos/${loan.id}`}
                            className="font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
                          >
                            {custName}
                          </Link>
                          <p className="text-xs text-slate-500">
                            {loan.customer?.document_type} {loan.customer?.document_number} ·{' '}
                            {formatDateCO(loan.disbursement_date)}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          <p className="font-medium text-slate-800">
                            {loan.billing_mode === 'monthly_interest_only'
                              ? 'Mensual solo interés'
                              : `${FREQUENCY_LABELS[loan.frequency] ?? loan.frequency} · ${loan.installments_count} cuotas`}
                          </p>
                          <p>
                            Interés: {loan.interest_rate}%
                            {loan.billing_mode === 'monthly_interest_only' &&
                              ` · Cap. vivo ${formatCOP(loan.current_capital ?? 0)}`}
                          </p>
                        </td>
                        <td className="tabular-nums px-4 py-3 text-right text-slate-700">
                          {formatCOP(loan.capital)}
                        </td>
                        <td className="tabular-nums px-4 py-3 text-right font-semibold text-slate-900">
                          {formatCOP(loan.contractual_total)}
                        </td>
                        <td className="px-4 py-3">
                          {loan.billing_mode === 'monthly_interest_only' ? (
                            <span className="inline-block rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                              Ciclo mensual
                            </span>
                          ) : (
                            <div className="w-28">
                              <div className="flex justify-between text-[11px] text-slate-500">
                                <span>
                                  {loan.paid_count}/{loan.installments_count}c
                                </span>
                                <span>{pct}%</span>
                              </div>
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-emerald-500"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="tabular-nums px-4 py-3 text-right">
                          <p className="font-bold text-slate-900">
                            {formatCOP(
                              loan.total_remaining ??
                                loan.installments_remaining + loan.penalties_remaining,
                            )}
                          </p>
                          {loan.overdue_count > 0 && (
                            <p className="text-[11px] font-semibold text-rose-600">
                              {loan.overdue_count} vencida(s)
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <LoanStatusBadge status={loan.status} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex gap-1.5">
                            <Link
                              href={`/prestamos/${loan.id}`}
                              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Detalle
                            </Link>
                            {loan.status === 'active' && loan.customer && (
                              <Link
                                href={`/pagos?customerId=${loan.customer.id}`}
                                className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                              >
                                Cobrar
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && filteredLoans.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-400">
                        No hay préstamos para mostrar con este filtro.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <form onSubmit={handleCreateLoan} className="grid gap-6 lg:grid-cols-3">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs lg:col-span-2">
              <h2 className="text-base font-bold text-slate-900">Condiciones financieras</h2>
              <p className="text-xs text-slate-500">
                El calendario de vencimientos respeta domingos y festivos ({holidays.length}{' '}
                festivos cargados).
              </p>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="sm:col-span-2">
                  Cliente
                  <select
                    required
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                  >
                    <option value="">Seleccione un cliente activo</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.first_names} {c.last_names} · {c.document_number}
                      </option>
                    ))}
                  </select>
                  {customers.length === 0 && !loading && (
                    <span className="text-xs text-amber-700">
                      Aún no hay clientes activos.{' '}
                      <Link href="/clientes" className="font-semibold underline">
                        Crea un cliente primero →
                      </Link>
                    </span>
                  )}
                </label>

                <div>
                  <label>
                    Capital prestado (COP)
                    <input
                      required
                      type="number"
                      min="1000"
                      step="1000"
                      value={capital || ''}
                      onChange={(e) => setCapital(Math.max(0, Math.round(Number(e.target.value))))}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {CAPITAL_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setCapital(preset)}
                        className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                          capital === preset
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {formatCOP(preset)}
                      </button>
                    ))}
                  </div>
                </div>

                <label>
                  Interés fijo sobre capital (%)
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Ingresa tu tasa (ej. 10, 15, 20)"
                    value={rateInput}
                    onChange={(e) => setRateInput(e.target.value)}
                  />
                  <span className="text-[11px] font-normal text-slate-400">
                    Tú defines libremente el porcentaje de interés para cada préstamo.
                  </span>
                </label>

                <label className="sm:col-span-2">
                  Esquema del crédito
                  <select
                    value={billingMode}
                    onChange={(e) => {
                      const next = e.target.value as BillingMode;
                      setBillingMode(next);
                      if (next === 'monthly_interest_only') setFrequency('monthly');
                    }}
                  >
                    <option value="fixed_installments">
                      Cuotas fijas cerradas (capital + interés dividido en N cuotas)
                    </option>
                    <option value="monthly_interest_only">
                      Mensual solo interés sobre capital (abierto con abonos a capital y retanqueos)
                    </option>
                  </select>
                </label>

                {!isMonthlyInterestOnly && (
                  <>
                    <label>
                      Modalidad de cobro
                      <select
                        value={frequency}
                        onChange={(e) => setFrequency(e.target.value as Frequency)}
                      >
                        <option value="daily">Diaria (lunes a sábado)</option>
                        <option value="weekly">Semanal (cada 7 días)</option>
                        <option value="biweekly">Quincenal (cada 15 días)</option>
                        <option value="monthly">Mensual (cada 30 días)</option>
                      </select>
                    </label>

                    <label>
                      Número de cuotas
                      <input
                        required
                        type="number"
                        min="1"
                        max="365"
                        value={count || ''}
                        onChange={(e) => setCount(Math.max(1, Math.round(Number(e.target.value))))}
                      />
                    </label>
                  </>
                )}

                <label>
                  Fecha de desembolso
                  <input
                    required
                    type="date"
                    value={disbursementDate}
                    onChange={(e) => setDisbursementDate(e.target.value)}
                  />
                </label>

                <label>
                  Fecha de primera cuota
                  <input
                    required
                    type="date"
                    min={disbursementDate}
                    value={firstPaymentDate}
                    onChange={(e) => setFirstPaymentDate(e.target.value)}
                  />
                </label>

                <label className="sm:col-span-2">
                  Estado inicial
                  <select
                    value={initialStatus}
                    onChange={(e) => setInitialStatus(e.target.value as 'active' | 'draft')}
                  >
                    <option value="active">Activo inmediato (desembolsado)</option>
                    <option value="draft">Borrador (para revisión previa)</option>
                  </select>
                </label>

                <label className="sm:col-span-2">
                  Observaciones / Garantía (opcional)
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Condiciones especiales, acuerdos de horario, fiador, etc."
                  />
                </label>
              </div>

              {exceedsRegulatory && (
                <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950">
                  <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-bold">Alerta de referencia regulatoria</p>
                    <p>
                      La tasa equivalente estimada ({equivalent.eaEquivalent}% EA) supera el límite
                      configurado ({reg.max_ea_rate}% EA según {reg.official_source}).{' '}
                      {reg.enforce_limit
                        ? 'El sistema bloqueará la activación directa hasta ajustar condiciones.'
                        : 'Se guardará la advertencia en el snapshot regulatorio.'}
                    </p>
                  </div>
                </div>
              )}

              {formError && (
                <p
                  role="alert"
                  className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700"
                >
                  {formError}
                </p>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-emerald-700 disabled:bg-slate-300"
                >
                  {saving
                    ? 'Creando préstamo…'
                    : initialStatus === 'draft'
                      ? 'Guardar borrador'
                      : 'Crear y activar préstamo'}
                </button>
                <button
                  type="button"
                  onClick={() => setTab('list')}
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancelar
                </button>
              </div>
            </section>

            <aside className="flex flex-col justify-between rounded-2xl bg-slate-950 p-6 text-white shadow-xs">
              <div>
                <h2 className="text-base font-bold">Resumen contractual</h2>
                <p className="mt-0.5 text-xs text-slate-400">Simulación en tiempo real</p>

                <dl className="mt-5 space-y-3.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Capital</dt>
                    <dd className="tabular-nums font-medium">{formatCOP(safeCapital)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">
                      Interés pactado ({rateInput.trim() === '' ? 'sin definir' : `${safeRate}%`})
                    </dt>
                    <dd className="tabular-nums font-medium">{formatCOP(q.interest)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">
                      {isMonthlyInterestOnly ? 'Cuota de interés mensual' : 'Cuota base'}
                    </dt>
                    <dd className="tabular-nums font-medium">
                      {formatCOP(q.values[0] ?? 0)}
                      {!isMonthlyInterestOnly &&
                        q.values.length > 1 &&
                        q.values[q.values.length - 1] !== q.values[0] &&
                        ` (última ${formatCOP(q.values[q.values.length - 1])})`}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">
                      {isMonthlyInterestOnly ? 'Esquema' : 'Duración aprox.'}
                    </dt>
                    <dd>
                      {isMonthlyInterestOnly
                        ? 'Mensual renovable'
                        : `${equivalent.estimatedDays} días`}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-400">Tasa equiv. mensual / EA</dt>
                    <dd className="tabular-nums text-xs text-slate-300">
                      {equivalent.monthlyEquivalent}% mes · {equivalent.eaEquivalent}% EA
                    </dd>
                  </div>
                  <div className="flex justify-between border-t border-slate-800 pt-4">
                    <dt className="font-semibold">Total a recaudar</dt>
                    <dd className="tabular-nums text-xl font-extrabold text-emerald-400">
                      {formatCOP(q.total)}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/80 p-3.5 text-xs text-slate-400">
                {reg.configured && reg.max_ea_rate > 0 ? (
                  <>
                    Control propio activo: referencia{' '}
                    <span className="font-semibold text-slate-200">{reg.max_ea_rate}% EA</span>
                    {reg.official_source ? ` (${reg.official_source})` : ''}.
                  </>
                ) : (
                  <>Tasa definida libremente por ti en cada préstamo (sin tope impuesto).</>
                )}
              </div>
            </aside>
          </form>

          <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  {isMonthlyInterestOnly
                    ? 'Proyección próximos ciclos mensuales (solo interés)'
                    : `Calendario proyectado (${dates.length} cuotas)`}
                </h2>
                <p className="text-xs text-slate-500">
                  Las fechas que caen en domingo o festivo se ajustan automáticamente al siguiente día
                  hábil.
                </p>
              </div>
            </div>
            <div className="mt-4 max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b border-slate-200 bg-white text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 px-3">Fecha programada</th>
                    <th className="py-2 px-3">Vencimiento efectivo</th>
                    <th className="py-2 pl-3 text-right">Valor cuota</th>
                  </tr>
                </thead>
                <tbody>
                  {dates.map((d, i) => {
                    const shifted = d.scheduled !== d.due;
                    return (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        <td className="py-2 pr-3 font-mono text-xs text-slate-500">#{i + 1}</td>
                        <td className="py-2 px-3 text-slate-600">{formatDateCO(d.scheduled)}</td>
                        <td className="py-2 px-3 font-medium text-slate-900">
                          {formatDateCO(d.due)}
                          {shifted && (
                            <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              Trasladada por festivo/domingo
                            </span>
                          )}
                        </td>
                        <td className="tabular-nums py-2 pl-3 text-right font-semibold text-slate-900">
                          {formatCOP(
                            isMonthlyInterestOnly ? (q.values[0] ?? 0) : (q.values[i] ?? 0),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

export default function PrestamosPage() {
  return (
    <AppShell
      title="Préstamos"
      subtitle="Administra tu cartera crediticia y simula nuevos planes de pago"
    >
      <Suspense fallback={<p className="text-sm text-slate-500">Cargando cartera…</p>}>
        <PrestamosContent />
      </Suspense>
    </AppShell>
  );
}
