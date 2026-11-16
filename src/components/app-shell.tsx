'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  CalendarIcon,
  CloseIcon,
  DashboardIcon,
  LoanIcon,
  MenuIcon,
  PaymentIcon,
  PlusIcon,
  ReportIcon,
  SettingsIcon,
  UsersIcon,
} from './icons';
import { useSessionInfo } from './session-provider';
import { SignOutButton } from './sign-out-button';

export { useSessionInfo };

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: DashboardIcon },
  { href: '/cuotas', label: 'Cobranza y Cuotas', icon: CalendarIcon },
  { href: '/clientes', label: 'Clientes', icon: UsersIcon },
  { href: '/prestamos', label: 'Préstamos', icon: LoanIcon },
  { href: '/pagos', label: 'Pagos', icon: PaymentIcon },
  { href: '/reportes', label: 'Reportes', icon: ReportIcon },
  { href: '/configuracion', label: 'Configuración', icon: SettingsIcon },
];

export function AppShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const session = useSessionInfo();

  const companyName = session.settings.business_profile.company_name || 'Nexo Crédito';

  const navContent = (
    <div className="flex min-h-full flex-col justify-between bg-slate-950 p-5 text-white">
      <div>
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 font-mono text-base font-extrabold text-emerald-400 ring-1 ring-emerald-500/30">
              N$
            </span>
            <div>
              <p className="text-base font-bold leading-tight text-white">{companyName}</p>
              <p className="text-[11px] font-medium text-slate-400">Gestión de Cartera COP</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white md:hidden"
            aria-label="Cerrar menú"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: IconComp }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                    : 'text-slate-300 hover:bg-slate-900 hover:text-white'
                }`}
              >
                <IconComp className={`h-4 w-4 ${active ? 'text-emerald-400' : 'text-slate-400'}`} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Acceso rápido
          </p>
          <div className="mt-2.5 grid gap-2">
            <Link
              href="/pagos"
              onClick={() => setMobileOpen(false)}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              <PaymentIcon className="h-3.5 w-3.5" />
              Registrar pago
            </Link>
            <Link
              href="/prestamos?nuevo=1"
              onClick={() => setMobileOpen(false)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Nuevo préstamo
            </Link>
            <Link
              href="/consulta"
              target="_blank"
              onClick={() => setMobileOpen(false)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white"
            >
              Portal público clientes ↗
            </Link>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t border-slate-800 pt-4">
        <div className="mb-3 px-2">
          <p className="truncate text-sm font-semibold text-white">{session.fullName}</p>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                session.isAdmin
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-sky-500/20 text-sky-300'
              }`}
            >
              {session.isAdmin ? 'Administrador' : 'Operador'}
            </span>
          </div>
        </div>
        <SignOutButton compact />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 overflow-y-auto md:block">
        {navContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-40 flex md:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] overflow-y-auto">{navContent}</aside>
        </div>
      )}

      {/* Main Content */}
      <div className="md:pl-64">
        <header className="no-print sticky top-0 z-20 border-b border-slate-200/80 bg-white/95 px-4 py-4 backdrop-blur-xs sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-50 md:hidden"
                aria-label="Abrir menú"
              >
                <MenuIcon className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                  {title}
                </h1>
                {subtitle && <p className="text-xs text-slate-500 sm:text-sm">{subtitle}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">{actions}</div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
