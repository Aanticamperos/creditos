import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './config';

/**
 * Server-only privileged Supabase client using the service role key.
 * Must NEVER be imported from client components or exposed to the browser.
 */
export function createAdminSupabaseClient() {
  if (typeof window !== 'undefined') {
    throw new Error('createAdminSupabaseClient solo puede ejecutarse en el servidor.');
  }
  const { url } = getSupabaseConfig();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !serviceRoleKey) {
    throw new Error('Falta configurar SUPABASE_SERVICE_ROLE_KEY o NEXT_PUBLIC_SUPABASE_URL.');
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
