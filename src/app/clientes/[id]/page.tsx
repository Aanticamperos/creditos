'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PaymentIcon, PlusIcon, WhatsAppIcon } from '@/components/icons';
import { LoanStatusBadge } from '@/components/status-badge';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import { buildWhatsAppUrl, FREQUENCY_LABELS, type Frequency } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface CustomerDetailPayload {
  customer: {
    id: string;
    document_type: string;
    document_number: string;
    first_names: string;
    last_names: string;
    phone: string;
    email: string | null;
    address: string | null;
    notes: string | null;
    archived_at: string | null;
    created_at: string;
  };
  loans: {
    id: string;
    capital: number;
    interest_rate: number;
    contractual_total: number;
    frequency: Frequency;
    installments_count: number;
    disbursement_date: string;
    status: string;
    paid_amount: number;
    remaining_installments: number;
    remaining_penalties: number;
    overdue_count: number;
  }[];
  payments: {
    id: string;
    received_amount: number;
    method: 'cash' | 'transfer';
    transfer_reference: string | null;
    received_at: string;
    reversed_at: string | null;
  }[];
  metrics: {
    totalCapitalBorrowed: number;
    totalPaidHistory: number;
    totalPendingBalance: number;
    totalPenaltiesPending: number;
    paidInstallments: number;
    overdueInstallments: number;
    totalInstallments: number;
  };
}

function CustomerDetailContent() {
  const { id } = useParams<{ id: string }>();
  const { notify } = useToast();
  const [data, setData] = useState<CustomerDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customers/${id}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando cliente');
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

  const customer = data?.customer;
  const fullName = customer ? `${customer.first_names} ${customer.last_names}` : 'Perfil del cliente';
  const waUrl = customer
    ? buildWhatsAppUrl(customer.phone, `Hola ${customer.first_names}, te contactamos de Nexo Crédito.`)
    : null;

  return (
    <AppShell
      title={fullName}
      subtitle={
        customer
          ? `${customer.document_type} ${customer.document_number} · Tel: ${customer.phone}`
          : 'Cargando perfil financiero…'
      }
      actions={
        customer && (
          <>
            <Link
              href="/clientes"
              className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              ← Volver
            </Link>
            {waUrl && (
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <WhatsAppIcon className="h-3.5 w-3.5" />
                WhatsApp
              </a>
            )}
            <Link
              href={`/pagos?customerId=${customer.id}`}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <PaymentIcon className="h-3.5 w-3.5" />
              Registrar pago
            </Link>
            {!customer.archived_at && (
              <Link
                href={`/prestamos?nuevo=1&customerId=${customer.id}`}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Nuevo préstamo
              </Link>
            )}
          </>
        )
      }
    >
      {loading && <p className="text-sm text-slate-500">Cargando información del cliente…</p>}

      {!loading && data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <article className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <p className="text-xs text-slate-500">Saldo pendiente total</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-slate-900">
                {formatCOP(
                  data.metrics.totalPendingBalance + data.metrics.totalPenaltiesPending,
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Mora pendiente: {formatCOP(data.metrics.totalPenaltiesPending)}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <p className="text-xs text-slate-500">Total pagado histórico</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-emerald-700">
                {formatCOP(data.metrics.totalPaidHistory)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Capital colocado: {formatCOP(data.metrics.totalCapitalBorrowed)}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <p className="text-xs text-slate-500">Cumplimiento de cuotas</p>
              <p className="tabular-nums mt-1.5 text-2xl font-extrabold text-slate-900">
                {data.metrics.paidInstallments} / {data.metrics.totalInstallments}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {data.metrics.overdueInstallments > 0
                  ? `${data.metrics.overdueInstallments} cuota(s) vencida(s)`
                  : 'Sin cuotas vencidas'}
              </p>
            </article>

            <article className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
              <p className="text-xs text-slate-500">Ficha y notas</p>
              <p className="mt-1.5 text-sm font-medium text-slate-800">
                {data.customer.address || 'Sin dirección registrada'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {data.customer.notes || data.customer.email || 'Sin observaciones'}
              </p>
            </article>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs lg:col-span-2">
              <h2 className="text-base font-bold text-slate-900">Préstamos del cliente</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Desembolso</th>
                      <th className="py-2 px-3">Modalidad</th>
                      <th className="py-2 px-3 text-right">Capital</th>
                      <th className="py-2 px-3 text-right">Total</th>
                      <th className="py-2 px-3 text-right">Saldo</th>
                      <th className="py-2 px-3">Estado</th>
                      <th className="py-2 pl-3 text-right">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.loans.map((loan) => (
                      <tr key={loan.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-3 pr-3 text-xs text-slate-700">
                          {formatDateCO(loan.disbursement_date)}
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-600">
                          {FREQUENCY_LABELS[loan.frequency] ?? loan.frequency} ·{' '}
                          {loan.installments_count}c
                        </td>
                        <td className="tabular-nums py-3 px-3 text-right">
                          {formatCOP(loan.capital)}
                        </td>
                        <td className="tabular-nums py-3 px-3 text-right font-medium">
                          {formatCOP(loan.contractual_total)}
                        </td>
                        <td className="tabular-nums py-3 px-3 text-right font-semibold text-slate-900">
                          {formatCOP(loan.remaining_installments + loan.remaining_penalties)}
                        </td>
                        <td className="py-3 px-3">
                          <LoanStatusBadge status={loan.status} />
                        </td>
                        <td className="py-3 pl-3 text-right">
                          <Link
                            href={`/prestamos/${loan.id}`}
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Abrir
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {data.loans.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-sm text-slate-400">
                          Este cliente aún no tiene préstamos.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
              <h2 className="text-base font-bold text-slate-900">Historial de pagos</h2>
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
                      <p className="font-semibold text-slate-800">
                        {p.method === 'cash' ? 'Efectivo' : 'Transferencia'}
                        {p.reversed_at && (
                          <span className="ml-2 text-xs font-bold text-rose-600">REVERSADO</span>
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
                  <p className="py-8 text-center text-sm text-slate-400">Sin pagos registrados.</p>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </AppShell>
  );
}

export default function CustomerDetailPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-slate-500">Cargando perfil…</p>}>
      <CustomerDetailContent />
    </Suspense>
  );
}
