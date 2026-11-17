'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { PrinterIcon, SearchIcon, WhatsAppIcon } from '@/components/icons';
import { InstallmentStatusBadge, LoanStatusBadge } from '@/components/status-badge';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { buildWhatsAppUrl } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface PublicInstallment {
  installment_number: number;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  remaining_amount: number;
  penalty_remaining: number;
  days_late: number;
  status: string;
}

interface PublicLoan {
  code: string;
  billing_mode?: 'fixed_installments' | 'monthly_interest_only';
  current_capital?: number;
  interest_rate?: number;
  frequency_label: string;
  installments_count: number;
  disbursement_date: string;
  status: string;
  contractual_total: number;
  paid_total: number;
  remaining_installments: number;
  recorded_penalties_remaining: number;
  estimated_penalties_remaining: number;
  paid_count: number;
  overdue_count: number;
  installments: PublicInstallment[];
}

interface ConsultaResponse {
  found: boolean;
  today?: string;
  customer_display?: string;
  document_type?: string;
  business?: {
    company_name: string;
    city: string;
    phone: string;
  };
  summary?: {
    total_pending: number;
    pending_installments: number;
    pending_penalties: number;
    total_paid: number;
    overdue_count: number;
    next_due_date: string | null;
    next_due_amount: number;
  };
  loans?: PublicLoan[];
  recent_payments?: {
    received_amount: number;
    method: 'cash' | 'transfer';
    received_at: string;
  }[];
}

export default function ConsultaPublicaPage() {
  const [documentNumber, setDocumentNumber] = useState('');
  const [business, setBusiness] = useState({ company_name: 'Nexo Crédito', city: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConsultaResponse | null>(null);

  useEffect(() => {
    fetch('/api/public/consulta')
      .then((r) => r.json())
      .then((json) => {
        if (json.business) setBusiness(json.business);
      })
      .catch(() => {});
  }, []);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    const cleaned = documentNumber.trim();
    if (cleaned.length < 5) {
      setError('Ingresa un número de documento válido (mínimo 5 dígitos).');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/public/consulta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_number: cleaned }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No fue posible realizar la consulta.');
        return;
      }
      setResult(json);
      if (json.business) setBusiness(json.business);
    } catch {
      setError('Error de conexión. Intenta nuevamente.');
    } finally {
      setLoading(false);
    }
  }

  const companyName = business.company_name || 'Nexo Crédito';
  const waAdvisorUrl = result?.found
    ? buildWhatsAppUrl(
        business.phone,
        `Hola ${companyName}, acabo de consultar mi estado de cuenta (documento ${documentNumber.trim()}) y quisiera validar un pago.`,
      )
    : buildWhatsAppUrl(business.phone, `Hola ${companyName}, necesito ayuda con mi crédito.`);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Bar */}
      <header className="no-print bg-slate-950 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 font-mono text-sm font-extrabold text-emerald-400 ring-1 ring-emerald-500/30">
              N$
            </span>
            <div>
              <p className="text-base font-bold leading-tight">{companyName}</p>
              <p className="text-[11px] text-slate-400">
                Portal de consulta de saldo{business.city ? ` · ${business.city}` : ''}
              </p>
            </div>
          </div>
          <Link
            href="/login"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            Acceso personal
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {/* Search Box */}
        <section className="no-print rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Consulta tu estado de cuenta
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Ingresa tu número de cédula o documento de identidad para revisar tu saldo pendiente,
            próxima cuota y plan de pagos.
          </p>

          <form onSubmit={handleSearch} className="mt-5 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                inputMode="numeric"
                required
                value={documentNumber}
                onChange={(e) => setDocumentNumber(e.target.value)}
                placeholder="Número de documento (ej. 1005786687)"
                className="pl-10"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {loading ? 'Consultando…' : 'Consultar saldo'}
            </button>
          </form>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700"
            >
              {error}
            </p>
          )}
        </section>

        {/* Not found */}
        {result && !result.found && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs">
            <p className="text-base font-semibold text-slate-800">
              No encontramos créditos asociados a ese número de documento.
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Verifica que el número esté bien escrito o comunícate con tu asesor.
            </p>
          </section>
        )}

        {/* Results */}
        {result && result.found && result.summary && (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Estado de cuenta al {formatDateCO(result.today)}
                </p>
                <h2 className="mt-0.5 text-xl font-bold text-slate-900">
                  {result.customer_display}
                </h2>
                <p className="text-xs text-slate-500">Documento: {result.document_type}</p>
              </div>
              <div className="no-print flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <PrinterIcon className="h-3.5 w-3.5" />
                  Imprimir resumen
                </button>
                {waAdvisorUrl && (
                  <a
                    href={waAdvisorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    <WhatsAppIcon className="h-3.5 w-3.5" />
                    Contactar asesor
                  </a>
                )}
              </div>
            </div>

            {/* KPI Summary */}
            <div className="grid gap-4 sm:grid-cols-3">
              <article className="rounded-2xl bg-slate-950 p-5 text-white shadow-xs">
                <p className="text-xs text-slate-400">Saldo total pendiente</p>
                <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-emerald-400">
                  {formatCOP(result.summary.total_pending)}
                </p>
                {result.summary.pending_penalties > 0 && (
                  <p className="mt-1 text-xs text-rose-300">
                    Incluye mora: {formatCOP(result.summary.pending_penalties)}
                  </p>
                )}
              </article>

              <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <p className="text-xs text-slate-500">Próxima cuota / vencimiento</p>
                <p className="mt-1.5 text-xl font-bold text-slate-900">
                  {result.summary.next_due_date
                    ? formatDateCO(result.summary.next_due_date)
                    : '¡Al día / Saldado!'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {result.summary.next_due_date
                    ? `Valor: ${formatCOP(result.summary.next_due_amount)}`
                    : 'Sin cuotas pendientes'}
                </p>
              </article>

              <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <p className="text-xs text-slate-500">Total abonado</p>
                <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-slate-900">
                  {formatCOP(result.summary.total_paid)}
                </p>
                <p
                  className={`mt-1 text-xs font-medium ${
                    result.summary.overdue_count > 0 ? 'text-rose-600' : 'text-emerald-700'
                  }`}
                >
                  {result.summary.overdue_count > 0
                    ? `${result.summary.overdue_count} cuota(s) vencida(s)`
                    : 'Sin cuotas en mora'}
                </p>
              </article>
            </div>

            {/* Loans */}
            {(result.loans ?? []).map((loan) => {
              const pct =
                loan.contractual_total > 0
                  ? Math.min(100, Math.round((loan.paid_total / loan.contractual_total) * 100))
                  : 0;
              return (
                <section
                  key={loan.code}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-base font-bold text-slate-900">
                          Crédito #{loan.code}
                        </h3>
                        <LoanStatusBadge status={loan.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Modalidad {loan.frequency_label} · {loan.installments_count} cuotas · Inicio{' '}
                        {formatDateCO(loan.disbursement_date)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500">
                        {loan.billing_mode === 'monthly_interest_only'
                          ? 'Total para liquidar (capital + interés)'
                          : 'Saldo del crédito'}
                      </p>
                      <p className="tabular-nums text-lg font-extrabold text-slate-900">
                        {formatCOP(
                          (loan.current_capital ?? 0) +
                            loan.remaining_installments +
                            loan.recorded_penalties_remaining,
                        )}
                      </p>
                      {loan.billing_mode === 'monthly_interest_only' &&
                        (loan.current_capital ?? 0) > 0 && (
                          <p className="text-[11px] text-slate-500">
                            Capital vivo: {formatCOP(loan.current_capital)} · Interés{' '}
                            {loan.interest_rate}%/mes
                          </p>
                        )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-slate-500">
                      <span>
                        Cuotas pagadas: {loan.paid_count} / {loan.installments_count}
                      </span>
                      <span className="font-semibold text-slate-800">{pct}% pagado</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                        <tr>
                          <th className="py-2 pr-3">#</th>
                          <th className="py-2 px-3">Fecha límite</th>
                          <th className="py-2 px-3 text-right">Valor</th>
                          <th className="py-2 px-3 text-right">Abonado</th>
                          <th className="py-2 px-3 text-right">Saldo</th>
                          <th className="py-2 pl-3">Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {loan.installments.map((inst) => (
                          <tr
                            key={inst.installment_number}
                            className="border-b border-slate-100 last:border-0"
                          >
                            <td className="py-2.5 pr-3 font-mono text-xs text-slate-500">
                              #{inst.installment_number}
                            </td>
                            <td className="py-2.5 px-3 text-xs font-medium text-slate-800">
                              {formatDateCO(inst.due_date)}
                            </td>
                            <td className="tabular-nums py-2.5 px-3 text-right">
                              {formatCOP(inst.original_amount)}
                            </td>
                            <td className="tabular-nums py-2.5 px-3 text-right text-emerald-700">
                              {formatCOP(inst.paid_amount)}
                            </td>
                            <td className="tabular-nums py-2.5 px-3 text-right font-semibold text-slate-900">
                              {formatCOP(inst.remaining_amount + inst.penalty_remaining)}
                              {inst.penalty_remaining > 0 && (
                                <span className="block text-[10px] font-medium text-rose-600">
                                  (mora {formatCOP(inst.penalty_remaining)})
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 pl-3">
                              <InstallmentStatusBadge status={inst.status} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}

            {/* Recent Payments */}
            {(result.recent_payments ?? []).length > 0 && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                <h3 className="text-base font-bold text-slate-900">Últimos abonos registrados</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(result.recent_payments ?? []).map((pay, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2.5 text-xs"
                    >
                      <div>
                        <p className="font-semibold text-slate-800">
                          {pay.method === 'cash' ? 'Efectivo' : 'Transferencia'}
                        </p>
                        <p className="text-slate-500">{formatDateTimeCO(pay.received_at)}</p>
                      </div>
                      <span className="tabular-nums text-sm font-bold text-emerald-700">
                        {formatCOP(pay.received_amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
