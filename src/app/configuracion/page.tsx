'use client';

import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useCallback, useEffect, useState } from 'react';
import { AppShell, useSessionInfo } from '@/components/app-shell';
import { PlusIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { formatDateCO, formatDateTimeCO } from '@/lib/dates';
import type { Frequency } from '@/lib/financial';
import { DEFAULT_SETTINGS, type AppSettingsBundle } from '@/lib/settings';

interface HolidayRow {
  holiday_date: string;
  description: string;
  source: string;
}

interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'employee';
  active: boolean;
  last_sign_in_at: string | null;
}

type TabKey = 'business' | 'rules' | 'holidays' | 'team';

function ConfiguracionContent() {
  const searchParams = useSearchParams();
  const { isAdmin, loading: sessionLoading, refresh: refreshSession } = useSessionInfo();
  const { notify } = useToast();

  const initialTabParam = searchParams.get('tab');
  const initialTab: TabKey =
    initialTabParam === 'holidays' ||
    initialTabParam === 'rules' ||
    initialTabParam === 'team' ||
    initialTabParam === 'business'
      ? initialTabParam
      : 'business';

  const [tab, setTab] = useState<TabKey>(initialTab);
  const [settings, setSettings] = useState<AppSettingsBundle>(DEFAULT_SETTINGS);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Manual holiday form
  const [newHolDate, setNewHolDate] = useState('');
  const [newHolDesc, setNewHolDesc] = useState('');

  // Team create form
  const [staffEmail, setStaffEmail] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffRole, setStaffRole] = useState<'employee' | 'admin'>('employee');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [setRes, holRes] = await Promise.all([
        fetch('/api/settings', { cache: 'no-store' }),
        fetch('/api/holidays', { cache: 'no-store' }),
      ]);
      const [setJson, holJson] = await Promise.all([setRes.json(), holRes.json()]);
      if (setRes.ok && setJson.settings) setSettings(setJson.settings);
      if (holRes.ok) setHolidays(holJson.holidays ?? []);

      if (isAdmin) {
        const teamRes = await fetch('/api/team', { cache: 'no-store' });
        const teamJson = await teamRes.json();
        if (teamRes.ok) setTeam(teamJson.members ?? []);
      }
    } catch {
      notify('Error cargando configuración.', 'error');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);

  async function saveSettings(partial: Partial<AppSettingsBundle>) {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error guardando parámetros');
      setSettings(json.settings);
      await refreshSession();
      notify('Configuración guardada correctamente.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function addSingleHoliday(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/holidays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          holiday_date: newHolDate,
          description: newHolDesc,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error agregando festivo');
      notify('Festivo agregado.', 'success');
      setNewHolDate('');
      setNewHolDesc('');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function loadColombiaYear(year: number) {
    setSaving(true);
    try {
      const res = await fetch('/api/holidays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'colombia_year', year }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error cargando festivos');
      notify(`Se cargaron los ${json.inserted} festivos oficiales de Colombia ${year}.`, 'success');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function deleteHoliday(date: string) {
    try {
      const res = await fetch(`/api/holidays?date=${encodeURIComponent(date)}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error eliminando festivo');
      notify('Festivo eliminado.', 'success');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    }
  }

  async function createStaff(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: staffEmail,
          password: staffPassword,
          full_name: staffName,
          role: staffRole,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error creando usuario');
      notify(`Usuario ${json.member.full_name} creado.`, 'success');
      setStaffEmail('');
      setStaffPassword('');
      setStaffName('');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function updateMember(id: string, updates: { role?: 'admin' | 'employee'; active?: boolean }) {
    try {
      const res = await fetch('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error actualizando usuario');
      notify('Perfil actualizado.', 'success');
      await loadAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Error', 'error');
    }
  }

  const toggleFrequency = (freq: Frequency) => {
    const current = settings.penalty_policy.apply_to_frequencies;
    const exists = current.includes(freq);
    const next = exists ? current.filter((f) => f !== freq) : [...current, freq];
    if (next.length === 0) return;
    setSettings({
      ...settings,
      penalty_policy: { ...settings.penalty_policy, apply_to_frequencies: next },
    });
  };

  return (
    <>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {(
          [
            ['business', 'Negocio y Comprobantes'],
            ['rules', 'Interés y Reglas de Mora'],
            ['holidays', `Festivos (${holidays.length})`],
            ...(isAdmin ? [['team', `Equipo (${team.length})`]] : []),
          ] as [TabKey, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
              tab === key
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {(loading || sessionLoading) && (
        <p className="text-sm text-slate-500">Cargando configuración…</p>
      )}

      {!loading && !sessionLoading && tab === 'business' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveSettings({ business_profile: settings.business_profile });
          }}
          className="max-w-2xl rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs"
        >
          <h2 className="text-base font-bold text-slate-900">Identidad comercial y recibos</h2>
          <p className="text-xs text-slate-500">
            Estos datos aparecen en el menú principal y en los comprobantes de pago.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label>
              Nombre comercial
              <input
                required
                disabled={!isAdmin}
                value={settings.business_profile.company_name}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    business_profile: {
                      ...settings.business_profile,
                      company_name: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              NIT / Documento (opcional)
              <input
                disabled={!isAdmin}
                value={settings.business_profile.nit}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    business_profile: { ...settings.business_profile, nit: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Teléfono de contacto
              <input
                disabled={!isAdmin}
                value={settings.business_profile.phone}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    business_profile: { ...settings.business_profile, phone: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Ciudad
              <input
                disabled={!isAdmin}
                value={settings.business_profile.city}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    business_profile: { ...settings.business_profile, city: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm:col-span-2">
              Mensaje pie de recibo
              <textarea
                rows={2}
                disabled={!isAdmin}
                value={settings.business_profile.receipt_footer}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    business_profile: {
                      ...settings.business_profile,
                      receipt_footer: e.target.value,
                    },
                  })
                }
              />
            </label>
          </div>

          {isAdmin && (
            <button
              type="submit"
              disabled={saving}
              className="mt-5 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {saving ? 'Guardando…' : 'Guardar identidad'}
            </button>
          )}
        </form>
      )}

      {!loading && !sessionLoading && tab === 'rules' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings({
                regulatory_policy: {
                  ...settings.regulatory_policy,
                  configured:
                    settings.regulatory_policy.max_ea_rate > 0 ||
                    Boolean(settings.regulatory_policy.official_source.trim()),
                },
              });
            }}
            className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs"
          >
            <h2 className="text-base font-bold text-slate-900">
              Control de tasa de interés (Opcional)
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Por defecto la tasa es <b>100% libre</b>: tú defines el interés en cada préstamo sin
              límites preestablecidos. Usa esta sección solo si deseas registrar un tope opcional.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label>
                Tope máximo E.A. (%) — 0 = sin límite
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  disabled={!isAdmin}
                  value={settings.regulatory_policy.max_ea_rate}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      regulatory_policy: {
                        ...settings.regulatory_policy,
                        max_ea_rate: Math.max(0, Number(e.target.value)),
                      },
                    })
                  }
                />
              </label>
              <label>
                Referencia mensual (%) — 0 = sin límite
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  disabled={!isAdmin}
                  value={settings.regulatory_policy.max_monthly_rate}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      regulatory_policy: {
                        ...settings.regulatory_policy,
                        max_monthly_rate: Math.max(0, Number(e.target.value)),
                      },
                    })
                  }
                />
              </label>
              <label className="sm:col-span-2">
                Fuente o nota de referencia (opcional)
                <input
                  disabled={!isAdmin}
                  value={settings.regulatory_policy.official_source}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      regulatory_policy: {
                        ...settings.regulatory_policy,
                        official_source: e.target.value,
                      },
                    })
                  }
                  placeholder="Ej. Política interna / Superfinanciera"
                />
              </label>
              <label>
                Vigente desde (opcional)
                <input
                  type="date"
                  disabled={!isAdmin}
                  value={settings.regulatory_policy.effective_from}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      regulatory_policy: {
                        ...settings.regulatory_policy,
                        effective_from: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-xs">
                <input
                  type="checkbox"
                  disabled={!isAdmin}
                  checked={settings.regulatory_policy.enforce_limit}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      regulatory_policy: {
                        ...settings.regulatory_policy,
                        enforce_limit: e.target.checked,
                      },
                    })
                  }
                  className="h-4 w-4 accent-emerald-600"
                />
                Bloquear activación si excede mi tope
              </label>
            </div>

            {isAdmin && (
              <button
                type="submit"
                disabled={saving}
                className="mt-5 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
              >
                {saving ? 'Guardando…' : 'Guardar control de tasa'}
              </button>
            )}
          </form>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings({ penalty_policy: settings.penalty_policy });
            }}
            className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs"
          >
            <h2 className="text-base font-bold text-slate-900">Política de mora y penalizaciones</h2>
            <p className="text-xs text-slate-500">
              Reglas usadas al calcular días hábiles de atraso y generar penalizaciones.
            </p>

            <div className="mt-5 space-y-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!isAdmin}
                  checked={settings.penalty_policy.enabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      penalty_policy: { ...settings.penalty_policy, enabled: e.target.checked },
                    })
                  }
                  className="h-4 w-4 accent-emerald-600"
                />
                Habilitar generación de penalizaciones por mora
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  Días hábiles por período
                  <input
                    type="number"
                    min="1"
                    max="60"
                    disabled={!isAdmin}
                    value={settings.penalty_policy.days_per_period}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        penalty_policy: {
                          ...settings.penalty_policy,
                          days_per_period: Math.max(1, Number(e.target.value)),
                        },
                      })
                    }
                  />
                </label>

                <label>
                  Valor de penalización por período
                  <select
                    disabled={!isAdmin}
                    value={settings.penalty_policy.penalty_mode}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        penalty_policy: {
                          ...settings.penalty_policy,
                          penalty_mode: e.target.value as 'installment_value' | 'fixed_percent',
                        },
                      })
                    }
                  >
                    <option value="installment_value">100% del valor de la cuota</option>
                    <option value="fixed_percent">Porcentaje personalizado de la cuota</option>
                  </select>
                </label>
              </div>

              {settings.penalty_policy.penalty_mode === 'fixed_percent' && (
                <label>
                  Porcentaje sobre la cuota (%)
                  <input
                    type="number"
                    min="1"
                    max="200"
                    disabled={!isAdmin}
                    value={settings.penalty_policy.percent_of_installment}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        penalty_policy: {
                          ...settings.penalty_policy,
                          percent_of_installment: Math.max(1, Number(e.target.value)),
                        },
                      })
                    }
                  />
                </label>
              )}

              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  disabled={!isAdmin}
                  checked={settings.penalty_policy.freeze_on_partial}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      penalty_policy: {
                        ...settings.penalty_policy,
                        freeze_on_partial: e.target.checked,
                      },
                    })
                  }
                  className="h-4 w-4 accent-emerald-600"
                />
                Congelar mora automáticamente al recibir abono parcial
              </label>

              <div>
                <p className="mb-2 text-xs font-medium text-slate-600">Modalidades con mora:</p>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ['daily', 'Diaria'],
                      ['weekly', 'Semanal'],
                      ['biweekly', 'Quincenal'],
                      ['monthly', 'Mensual'],
                    ] as [Frequency, string][]
                  ).map(([freq, label]) => {
                    const active = settings.penalty_policy.apply_to_frequencies.includes(freq);
                    return (
                      <button
                        key={freq}
                        type="button"
                        disabled={!isAdmin}
                        onClick={() => toggleFrequency(freq)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                          active
                            ? 'bg-emerald-600 text-white'
                            : 'border border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {isAdmin && (
              <button
                type="submit"
                disabled={saving}
                className="mt-5 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
              >
                {saving ? 'Guardando…' : 'Guardar política de mora'}
              </button>
            )}
          </form>
        </div>
      )}

      {!loading && !sessionLoading && tab === 'holidays' && (
        <div className="grid gap-6 lg:grid-cols-3">
          {isAdmin && (
            <section className="space-y-5 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs">
              <div>
                <h2 className="text-base font-bold text-slate-900">Festivos de Colombia</h2>
                <p className="text-xs text-slate-500">
                  Carga automática con Ley Emiliani y Semana Santa.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[2026, 2027, 2028].map((yr) => (
                    <button
                      key={yr}
                      type="button"
                      disabled={saving}
                      onClick={() => loadColombiaYear(yr)}
                      className="rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                    >
                      Cargar {yr}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={addSingleHoliday} className="border-t border-slate-100 pt-5">
                <h3 className="text-sm font-bold text-slate-900">Agregar día no hábil manual</h3>
                <div className="mt-3 space-y-3">
                  <label>
                    Fecha
                    <input
                      required
                      type="date"
                      value={newHolDate}
                      onChange={(e) => setNewHolDate(e.target.value)}
                    />
                  </label>
                  <label>
                    Motivo / Descripción
                    <input
                      required
                      value={newHolDesc}
                      onChange={(e) => setNewHolDesc(e.target.value)}
                      placeholder="Ej. Día cívico local"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-900 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Agregar festivo
                  </button>
                </div>
              </form>
            </section>
          )}

          <section
            className={`rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs ${
              isAdmin ? 'lg:col-span-2' : 'lg:col-span-3'
            }`}
          >
            <h2 className="text-base font-bold text-slate-900">
              Calendario de días no hábiles ({holidays.length})
            </h2>
            <div className="mt-4 max-h-96 overflow-y-auto overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b border-slate-200 bg-white text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 px-3">Descripción</th>
                    <th className="py-2 px-3">Origen</th>
                    {isAdmin && <th className="py-2 pl-3 text-right">Acción</th>}
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.holiday_date} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-slate-900">
                        {formatDateCO(h.holiday_date)} ({h.holiday_date})
                      </td>
                      <td className="py-2.5 px-3 text-slate-800">{h.description}</td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">{h.source}</td>
                      {isAdmin && (
                        <td className="py-2.5 pl-3 text-right">
                          <button
                            type="button"
                            onClick={() => deleteHoliday(h.holiday_date)}
                            className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                          >
                            Eliminar
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {holidays.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-sm text-slate-400">
                        Aún no hay festivos cargados. Usa &ldquo;Cargar 2026&rdquo; para empezar.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {!loading && !sessionLoading && tab === 'team' && isAdmin && (
        <div className="grid gap-6 lg:grid-cols-3">
          <form
            onSubmit={createStaff}
            className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs"
          >
            <h2 className="text-base font-bold text-slate-900">Crear usuario de equipo</h2>
            <p className="text-xs text-slate-500">
              Aprovisionamiento seguro directo sin registro público.
            </p>
            <div className="mt-4 space-y-3">
              <label>
                Nombre completo
                <input
                  required
                  value={staffName}
                  onChange={(e) => setStaffName(e.target.value)}
                  placeholder="Juan Cobrador"
                />
              </label>
              <label>
                Correo electrónico
                <input
                  required
                  type="email"
                  value={staffEmail}
                  onChange={(e) => setStaffEmail(e.target.value)}
                  placeholder="operador@empresa.com"
                />
              </label>
              <label>
                Contraseña inicial (mín. 8 caracteres)
                <input
                  required
                  minLength={8}
                  type="password"
                  value={staffPassword}
                  onChange={(e) => setStaffPassword(e.target.value)}
                />
              </label>
              <label>
                Rol
                <select
                  value={staffRole}
                  onChange={(e) => setStaffRole(e.target.value as 'employee' | 'admin')}
                >
                  <option value="employee">Operador / Cobrador</option>
                  <option value="admin">Administrador</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={saving}
                className="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
              >
                {saving ? 'Creando…' : 'Crear acceso'}
              </button>
            </div>
          </form>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs lg:col-span-2">
            <h2 className="text-base font-bold text-slate-900">Personal autorizado</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Nombre</th>
                    <th className="py-2 px-3">Correo</th>
                    <th className="py-2 px-3">Rol</th>
                    <th className="py-2 px-3">Estado</th>
                    <th className="py-2 pl-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((m) => (
                    <tr key={m.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-3 pr-3 font-semibold text-slate-900">
                        {m.full_name}
                        {m.last_sign_in_at && (
                          <p className="text-[11px] font-normal text-slate-400">
                            Último ingreso: {formatDateTimeCO(m.last_sign_in_at)}
                          </p>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-600">{m.email}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                            m.role === 'admin'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-sky-50 text-sky-700'
                          }`}
                        >
                          {m.role === 'admin' ? 'Administrador' : 'Operador'}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            m.active ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                          }`}
                        >
                          {m.active ? 'Activo' : 'Desactivado'}
                        </span>
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <div className="inline-flex gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              updateMember(m.id, {
                                role: m.role === 'admin' ? 'employee' : 'admin',
                              })
                            }
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Cambiar rol
                          </button>
                          <button
                            type="button"
                            onClick={() => updateMember(m.id, { active: !m.active })}
                            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            {m.active ? 'Desactivar' : 'Activar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default function ConfiguracionPage() {
  return (
    <AppShell
      title="Configuración"
      subtitle="Parámetros de negocio, reglas de mora, festivos y equipo"
    >
      <Suspense fallback={<p className="text-sm text-slate-500">Cargando configuración…</p>}>
        <ConfiguracionContent />
      </Suspense>
    </AppShell>
  );
}
