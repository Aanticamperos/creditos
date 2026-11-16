import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createServerSupabaseClient } from './supabase/server';
import { createAdminSupabaseClient } from './supabase/admin';

export type UserRole = 'admin' | 'employee';

export interface StaffProfile {
  id: string;
  full_name: string;
  role: UserRole;
  active: boolean;
  created_at: string;
}

export interface AuthContext {
  user: User;
  profile: StaffProfile;
  serverClient: SupabaseClient;
  adminClient: SupabaseClient;
}

export async function requireAuth(): Promise<
  { ok: true; ctx: AuthContext } | { ok: false; response: NextResponse }
> {
  try {
    const serverClient = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await serverClient.auth.getUser();

    if (authError || !user) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' },
          { status: 401 },
        ),
      };
    }

    const adminClient = createAdminSupabaseClient();
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('id, full_name, role, active, created_at')
      .eq('id', user.id)
      .maybeSingle<StaffProfile>();

    if (profileError || !profile) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Tu usuario no tiene un perfil operativo asignado.' },
          { status: 403 },
        ),
      };
    }

    if (!profile.active) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Tu usuario está desactivado. Contacta al administrador.' },
          { status: 403 },
        ),
      };
    }

    return {
      ok: true,
      ctx: { user, profile, serverClient, adminClient },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error verificando autenticación';
    return {
      ok: false,
      response: NextResponse.json({ error: message }, { status: 500 }),
    };
  }
}

export async function requireAdmin(): Promise<
  { ok: true; ctx: AuthContext } | { ok: false; response: NextResponse }
> {
  const auth = await requireAuth();
  if (!auth.ok) return auth;
  if (auth.ctx.profile.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Esta acción requiere permisos de administrador.' },
        { status: 403 },
      ),
    };
  }
  return auth;
}
