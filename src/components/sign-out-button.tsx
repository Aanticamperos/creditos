'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { LogOutIcon } from './icons';

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={signOut}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
      >
        <LogOutIcon className="h-4 w-4" />
        Cerrar sesión
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={signOut}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
    >
      <LogOutIcon className="h-4 w-4" />
      <span className="hidden sm:inline">Cerrar sesión</span>
    </button>
  );
}
