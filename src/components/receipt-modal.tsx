'use client';

import { formatDateTimeCO } from '@/lib/dates';
import { buildWhatsAppUrl } from '@/lib/financial';
import { formatCOP } from '@/lib/money';
import type { BusinessProfileSettings } from '@/lib/settings';
import { CloseIcon, PrinterIcon, WhatsAppIcon } from './icons';

export interface ReceiptData {
  id: string;
  received_amount: number;
  method: 'cash' | 'transfer';
  transfer_reference?: string | null;
  received_at: string;
  notes?: string | null;
  customer: {
    first_names: string;
    last_names: string;
    document_type: string;
    document_number: string;
    phone?: string | null;
  } | null;
  allocations: {
    id: string;
    installment_id?: string | null;
    penalty_id?: string | null;
    amount: number;
    label?: string;
  }[];
  business_profile?: BusinessProfileSettings;
}

export function ReceiptModal({
  receipt,
  onClose,
}: {
  receipt: ReceiptData | null;
  onClose: () => void;
}) {
  if (!receipt) return null;

  const companyName = receipt.business_profile?.company_name || 'Nexo Crédito';
  const customerName = receipt.customer
    ? `${receipt.customer.first_names} ${receipt.customer.last_names}`
    : 'Cliente';

  const shortRef = receipt.id.slice(0, 8).toUpperCase();
  const methodLabel = receipt.method === 'cash' ? 'Efectivo' : 'Transferencia';
  const whatsAppMsg = [
    `*${companyName} — Comprobante de Pago #${shortRef}*`,
    `Cliente: ${customerName}`,
    `Fecha: ${formatDateTimeCO(receipt.received_at)}`,
    `Valor recibido: *${formatCOP(receipt.received_amount)}*`,
    `Método: ${methodLabel}${receipt.transfer_reference ? ` (Ref: ${receipt.transfer_reference})` : ''}`,
    receipt.business_profile?.receipt_footer || 'Gracias por su pago puntual.',
  ].join('\n');

  const waUrl = buildWhatsAppUrl(receipt.customer?.phone, whatsAppMsg);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="no-print mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">Comprobante de pago</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Cerrar comprobante"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-5 text-sm">
          <div className="text-center">
            <p className="text-base font-bold text-slate-900">{companyName}</p>
            {receipt.business_profile?.nit && (
              <p className="text-xs text-slate-500">NIT / ID: {receipt.business_profile.nit}</p>
            )}
            {receipt.business_profile?.city && (
              <p className="text-xs text-slate-500">{receipt.business_profile.city}</p>
            )}
            <p className="mt-2 inline-block rounded-full bg-emerald-100 px-3 py-0.5 font-mono text-xs font-semibold text-emerald-800">
              Recibo #{shortRef}
            </p>
          </div>

          <dl className="mt-5 space-y-2 border-t border-slate-200 pt-4 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Fecha</dt>
              <dd className="font-medium text-slate-800">
                {formatDateTimeCO(receipt.received_at)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Cliente</dt>
              <dd className="text-right font-medium text-slate-800">{customerName}</dd>
            </div>
            {receipt.customer && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Documento</dt>
                <dd className="font-mono text-slate-700">
                  {receipt.customer.document_type} {receipt.customer.document_number}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Medio</dt>
              <dd className="font-medium text-slate-800">{methodLabel}</dd>
            </div>
            {receipt.transfer_reference && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Referencia</dt>
                <dd className="font-mono text-slate-800">{receipt.transfer_reference}</dd>
              </div>
            )}
          </dl>

          <div className="mt-4 border-t border-slate-200 pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Detalle aplicado
            </p>
            <ul className="space-y-1.5 text-xs">
              {receipt.allocations.map((alloc) => (
                <li key={alloc.id} className="flex justify-between text-slate-700">
                  <span>
                    {alloc.label ??
                      (alloc.penalty_id ? 'Abono a penalización / mora' : 'Abono a cuota')}
                  </span>
                  <span className="tabular-nums font-semibold">{formatCOP(alloc.amount)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-slate-300 pt-3">
            <span className="text-sm font-bold text-slate-900">TOTAL RECIBIDO</span>
            <span className="tabular-nums text-lg font-extrabold text-emerald-700">
              {formatCOP(receipt.received_amount)}
            </span>
          </div>

          <p className="mt-4 text-center text-[11px] text-slate-500">
            {receipt.business_profile?.receipt_footer ||
              'Gracias por su pago puntual. Conserve este comprobante.'}
          </p>
        </div>

        <div className="no-print mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <PrinterIcon className="h-4 w-4" />
            Imprimir
          </button>
          {waUrl && (
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              <WhatsAppIcon className="h-4 w-4" />
              Enviar WhatsApp
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
