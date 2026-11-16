import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { loadAppSettings } from '@/lib/settings';
import { firstZodError, settingsUpdateSchema } from '@/lib/validation';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const settings = await loadAppSettings(auth.ctx.adminClient);
  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const now = new Date().toISOString();
  const entries: { key: string; value: Record<string, unknown>; updated_by: string; updated_at: string }[] = [];

  if (parsed.data.business_profile) {
    entries.push({
      key: 'business_profile',
      value: parsed.data.business_profile,
      updated_by: user.id,
      updated_at: now,
    });
  }
  if (parsed.data.regulatory_policy) {
    entries.push({
      key: 'regulatory_policy',
      value: parsed.data.regulatory_policy,
      updated_by: user.id,
      updated_at: now,
    });
  }
  if (parsed.data.penalty_policy) {
    entries.push({
      key: 'penalty_policy',
      value: parsed.data.penalty_policy,
      updated_by: user.id,
      updated_at: now,
    });
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: 'No se recibieron parámetros para actualizar.' }, { status: 400 });
  }

  const { error } = await adminClient
    .from('app_settings')
    .upsert(entries, { onConflict: 'key' });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'settings_updated',
    entity_type: 'app_settings',
    new_data: { keys: entries.map((e) => e.key) },
  });

  const settings = await loadAppSettings(adminClient);
  return NextResponse.json({ settings });
}
