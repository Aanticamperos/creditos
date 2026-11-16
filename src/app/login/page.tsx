'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import { createClient } from '@/lib/supabase';
import { getSupabaseConfig } from '@/lib/supabase/config';

const { configured } = getSupabaseConfig();

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!configured) return;
    setError('');
    setLoading(true);
    try {
      const { error: authError } = await createClient().auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError('No fue posible iniciar sesión. Verifica el correo y la contraseña.');
        setLoading(false);
        return;
      }
      const nextParam = new URLSearchParams(window.location.search).get('next') ?? '/';
      const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';
      router.push(safeNext);
      router.refresh();
    } catch {
      setError('Error de conexión con el servidor de autenticación.');
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800/60 bg-white p-8 shadow-2xl">
        <div className="mb-7">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 font-mono text-sm font-extrabold text-white">
              N$
            </span>
            <p className="text-sm font-bold tracking-wider text-emerald-700">NEXO CRÉDITO</p>
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900">Bienvenido</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Acceso exclusivo para personal autorizado de administración y cobranza.
          </p>
        </div>

        {!configured && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <b>Falta configurar Supabase.</b>
            <br />
            Configura <code>NEXT_PUBLIC_SUPABASE_URL</code> y{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> en <code>.env.local</code> y reinicia el
            servidor.
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <label>
            Correo electrónico
            <input
              type="email"
              autoComplete="email"
              required
              placeholder="correo@ejemplo.com"
              disabled={!configured || loading}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label>
            Contraseña
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                className="pr-10"
                disabled={!configured || loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute inset-y-0 right-2.5 flex items-center text-slate-400 hover:text-slate-700"
                aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              </button>
            </div>
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!configured || loading}
            className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? 'Ingresando…' : 'Iniciar sesión'}
          </button>
        </form>

        <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-center">
          <p className="text-xs text-slate-400">
            Registro público deshabilitado. Los accesos se gestionan desde Administración.
          </p>
          <Link
            href="/consulta"
            className="inline-block text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
          >
            ¿Eres cliente? Consulta el saldo de tu crédito aquí →
          </Link>
        </div>
      </div>
    </main>
  );
}
