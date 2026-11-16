import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { getColombianHolidays } from '@/lib/colombia-holidays';
import { firstZodError, holidayCreateSchema } from '@/lib/validation';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.adminClient
    .from('business_holidays')
    .select('holiday_date, description, source, created_at')
    .order('holiday_date', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ holidays: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = holidayCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;

  if (parsed.data.mode === 'single') {
    const { holiday_date, description } = parsed.data;
    const { data, error } = await adminClient
      .from('business_holidays')
      .upsert({ holiday_date, description, source: 'manual' }, { onConflict: 'holiday_date' })
      .select('*')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await writeAuditLog(adminClient, {
      actor_id: user.id,
      action: 'holiday_upserted',
      entity_type: 'business_holiday',
      new_data: { holiday_date, description },
    });

    return NextResponse.json({ holiday: data, inserted: 1 }, { status: 201 });
  }

  const items = getColombianHolidays(parsed.data.year);
  const { data, error } = await adminClient
    .from('business_holidays')
    .upsert(items, { onConflict: 'holiday_date' })
    .select('*');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'colombia_holidays_loaded',
    entity_type: 'business_holiday',
    new_data: { year: parsed.data.year, count: items.length },
  });

  return NextResponse.json({ holidays: data ?? items, inserted: items.length }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const date = request.nextUrl.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Fecha inválida.' }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const { error } = await adminClient
    .from('business_holidays')
    .delete()
    .eq('holiday_date', date);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'holiday_deleted',
    entity_type: 'business_holiday',
    old_data: { holiday_date: date },
  });

  return NextResponse.json({ deleted: date });
}
