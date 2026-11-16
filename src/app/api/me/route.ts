import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { loadAppSettings } from '@/lib/settings';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const settings = await loadAppSettings(auth.ctx.adminClient);
  return NextResponse.json({
    user: {
      id: auth.ctx.user.id,
      email: auth.ctx.user.email ?? '',
    },
    profile: auth.ctx.profile,
    settings,
  });
}
