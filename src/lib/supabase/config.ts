/**
 * Normalizes the configured Supabase project URL, stripping accidental
 * `/rest/v1` suffixes or trailing slashes so Auth and REST clients always
 * target the project root.
 */
export function normalizeSupabaseUrl(raw: string | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

export function getSupabaseConfig() {
  const url = normalizeSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  return {
    url,
    anonKey,
    configured: Boolean(url && anonKey),
  };
}
