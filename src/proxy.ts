import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseConfig } from '@/lib/supabase/config';

/** Refreshes Supabase auth cookies and protects every application route and API endpoint. */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { url, anonKey, configured } = getSupabaseConfig();

  if (!configured) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Falta configurar las credenciales de Supabase.' },
        { status: 503 },
      );
    }
    if (pathname !== '/login') {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getClaims verifies the JWT rather than trusting an unverified cookie payload.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  if (!signedIn) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'No autorizado. Inicia sesión nuevamente.' },
        { status: 401 },
      );
    }
    if (pathname !== '/login') {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  if (signedIn && pathname === '/login') {
    const nextParam = request.nextUrl.searchParams.get('next') ?? '/';
    const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = safeNext;
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
