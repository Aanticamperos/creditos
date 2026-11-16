'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_SETTINGS, type AppSettingsBundle } from '@/lib/settings';

export interface SessionInfo {
  loading: boolean;
  userId: string;
  email: string;
  fullName: string;
  role: 'admin' | 'employee';
  isAdmin: boolean;
  settings: AppSettingsBundle;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionInfo>({
  loading: true,
  userId: '',
  email: '',
  fullName: 'Operador',
  role: 'employee',
  isAdmin: false,
  settings: DEFAULT_SETTINGS,
  refresh: async () => {},
});

export function useSessionInfo() {
  return useContext(SessionContext);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<Omit<SessionInfo, 'refresh'>>({
    loading: true,
    userId: '',
    email: '',
    fullName: 'Cargando…',
    role: 'employee',
    isAdmin: false,
    settings: DEFAULT_SETTINGS,
  });

  const refresh = useCallback(async () => {
    if (pathname === '/login') {
      setSession((prev) => ({ ...prev, loading: false }));
      return;
    }
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (!res.ok) {
        setSession((prev) => ({ ...prev, loading: false }));
        return;
      }
      const json = await res.json();
      setSession({
        loading: false,
        userId: json.user?.id ?? '',
        email: json.user?.email ?? '',
        fullName: json.profile?.full_name ?? 'Operador',
        role: json.profile?.role ?? 'employee',
        isAdmin: json.profile?.role === 'admin',
        settings: json.settings ?? DEFAULT_SETTINGS,
      });
    } catch {
      setSession((prev) => ({ ...prev, loading: false }));
    }
  }, [pathname]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(id);
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ ...session, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}
