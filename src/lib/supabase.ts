import { createBrowserClient } from '@supabase/ssr';
import { getSupabaseConfig } from './supabase/config';

export const createClient = () => {
  const { url, anonKey } = getSupabaseConfig();
  return createBrowserClient(url, anonKey);
};
