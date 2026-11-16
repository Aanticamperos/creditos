'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useSessionInfo } from '@/components/app-shell';
import { CloseIcon, PlusIcon, SearchIcon, WhatsAppIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { buildWhatsAppUrl } from '@/lib/financial';
import { formatCOP } from '@/lib/money';

interface CustomerRow {
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
  summary: {
    active_loans: number;
    total_loans: number;
    pending_balance: number;
    overdue_installments: number;
  };
}

const EMPTY_FORM = {
  document_type: 'CC',
  document_number: '',
  first_names: '',
  last_names: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
};

function ClientesContent() {
  const { isAdmin } = useSessionInfo();
  const { notify } = useToast();

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/customers?includeArchived=${includeArchived ? 'true' : 'false'}`,
        { cache: 'no-store' },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando clientes');
      setCustomers(json.customers ?? []);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error cargando clientes', 'error');
    } finally {
      setLoading(false);
    }
  }, [includeArchived, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => {
      const text = `${c.first_names} ${c.last_names} ${c.document_number} ${c.phone}`.toLowerCase();
      return text.includes(q);
    });
  }, [customers, search]);

  function openNewModal() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setModalOpen(true);
  }

  function openEditModal(c: CustomerRow) {
    setEditingId(c.id);
    setForm({
      document_type: c.document_type,
      document_number: c.document_number,
      first_names: c.first_names,
      last_names: c.last_names,
      phone: c.phone,
      email: c.email ?? '',
      address: c.address ?? '',
      notes: c.notes ?? '',
    });
    setFormError('');
    setModalOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const endpoint = editingId ? `/api/customers/${editingId}` : '/api/customers';
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error ?? 'Error guardando cliente');
        return;
      }
      notify(editingId ? 'Cliente actualizado.' : 'Cliente registrado exitosamente.', 'success');
      setModalOpen(false);
      await load();
    } catch {
      setFormError('Error de red al guardar el cliente.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(c: CustomerRow) {
    const nextArchived = !c.archived_at;
    try {
      const res = await fetch(`/api/customers/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: nextArchived }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'No fue posible actualizar el cliente');
      notify(nextArchived ? 'Cliente archivado.' : 'Cliente restaurado.', 'success');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    }
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, documento o teléfono…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-4 w-4 rounded accent-emerald-600"
            />
            Mostrar archivados
          </label>
          <button
            type="button"
            onClick={openNewModal}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700"
          >
            <PlusIcon className="h-4 w-4" />
            Nuevo cliente
          </button>
        </div>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/70 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Documento</th>
                <th className="px-4 py-3">Contacto</th>
                <th className="px-4 py-3 text-center">Créditos activos</th>
                <th className="px-4 py-3 text-right">Saldo pendiente</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const fullName = `${c.first_names} ${c.last_names}`;
                const waUrl = buildWhatsAppUrl(
                  c.phone,
                  `Hola ${c.first_names}, te escribimos de Nexo Crédito.`,
                );
                return (
                  <tr
                    key={c.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      c.archived_at ? 'bg-slate-50/80 opacity-65' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/clientes/${c.id}`}
                        className="font-semibold text-slate-900 hover:text-emerald-700 hover:underline"
                      >
                        {fullName}
                      </Link>
                      {c.archived_at && (
                        <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                          Archivado
                        </span>
                      )}
                      {c.address && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">{c.address}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">
                      {c.document_type} {c.document_number}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-700">{c.phone}</span>
                        {waUrl && (
                          <a
                            href={waUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Abrir chat de WhatsApp"
                            className="rounded-md bg-emerald-50 p-1 text-emerald-700 hover:bg-emerald-100"
                          >
                            <WhatsAppIcon className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      {c.email && <p className="text-xs text-slate-400">{c.email}</p>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-semibold text-slate-900">
                        {c.summary.active_loans}
                      </span>
                      {c.summary.overdue_installments > 0 && (
                        <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                          {c.summary.overdue_installments} venc.
                        </span>
                      )}
                    </td>
                    <td className="tabular-nums px-4 py-3 text-right font-semibold text-slate-900">
                      {formatCOP(c.summary.pending_balance)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Link
                          href={`/clientes/${c.id}`}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Perfil
                        </Link>
                        <button
                          type="button"
                          onClick={() => openEditModal(c)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Editar
                        </button>
                        {!c.archived_at && (
                          <Link
                            href={`/prestamos?nuevo=1&customerId=${c.id}`}
                            className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            + Prestar
                          </Link>
                        )}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => toggleArchive(c)}
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                          >
                            {c.archived_at ? 'Restaurar' : 'Archivar'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                    {search
                      ? 'No se encontraron clientes con ese criterio.'
                      : 'Aún no hay clientes registrados. Crea el primero con el botón "+ Nuevo cliente".'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={save}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-900">
                {editingId ? 'Editar cliente' : 'Registrar nuevo cliente'}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-3.5 sm:grid-cols-2">
              <label>
                Tipo de documento
                <select
                  value={form.document_type}
                  onChange={(e) => setForm({ ...form, document_type: e.target.value })}
                >
                  <option value="CC">CC — Cédula</option>
                  <option value="CE">CE — Extranjería</option>
                  <option value="NIT">NIT</option>
                  <option value="Pasaporte">Pasaporte</option>
                </select>
              </label>

              <label>
                Número de documento
                <input
                  required
                  value={form.document_number}
                  onChange={(e) => setForm({ ...form, document_number: e.target.value })}
                  placeholder="1010123456"
                />
              </label>

              <label>
                Nombres
                <input
                  required
                  value={form.first_names}
                  onChange={(e) => setForm({ ...form, first_names: e.target.value })}
                  placeholder="Carlos Andrés"
                />
              </label>

              <label>
                Apellidos
                <input
                  required
                  value={form.last_names}
                  onChange={(e) => setForm({ ...form, last_names: e.target.value })}
                  placeholder="Gómez Pérez"
                />
              </label>

              <label>
                Teléfono / WhatsApp
                <input
                  required
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="3001234567"
                />
              </label>

              <label>
                Correo (opcional)
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="cliente@correo.com"
                />
              </label>

              <label className="sm:col-span-2">
                Dirección / Barrio (opcional)
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Cra 15 # 20-30, Barrio Centro"
                />
              </label>

              <label className="sm:col-span-2">
                Notas o referencias (opcional)
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Horario de cobro, referencia familiar, etc."
                />
              </label>
            </div>

            {formError && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
              >
                {formError}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
              >
                {saving ? 'Guardando…' : editingId ? 'Guardar cambios' : 'Crear cliente'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export default function ClientesPage() {
  return (
    <AppShell
      title="Clientes"
      subtitle="Directorio, contacto directo y saldo consolidado de deudores"
    >
      <ClientesContent />
    </AppShell>
  );
}
