import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { firstZodError, teamCreateSchema, teamPatchSchema } from '@/lib/validation';

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { adminClient } = auth.ctx;
  const [{ data: profiles, error: profErr }, { data: authUsers, error: authErr }] =
    await Promise.all([
      adminClient
        .from('profiles')
        .select('id, full_name, role, active, created_at')
        .order('created_at', { ascending: true }),
      adminClient.auth.admin.listUsers({ page: 1, perPage: 200 }),
    ]);

  if (profErr) {
    return NextResponse.json({ error: profErr.message }, { status: 500 });
  }
  if (authErr) {
    return NextResponse.json({ error: authErr.message }, { status: 500 });
  }

  const emailMap = new Map<string, { email: string; last_sign_in_at: string | null }>();
  for (const u of authUsers.users ?? []) {
    emailMap.set(u.id, {
      email: u.email ?? '',
      last_sign_in_at: u.last_sign_in_at ?? null,
    });
  }

  const members = (profiles ?? []).map((p) => ({
    ...p,
    email: emailMap.get(p.id)?.email ?? '',
    last_sign_in_at: emailMap.get(p.id)?.last_sign_in_at ?? null,
  }));

  return NextResponse.json({ members });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = teamCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const { email, password, full_name, role } = parsed.data;

  const { data: createdAuth, error: createAuthErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
  });

  if (createAuthErr || !createdAuth.user) {
    return NextResponse.json(
      { error: createAuthErr?.message ?? 'No fue posible crear el usuario en Auth.' },
      { status: 400 },
    );
  }

  const { data: profile, error: profErr } = await adminClient
    .from('profiles')
    .insert({
      id: createdAuth.user.id,
      full_name,
      role,
      active: true,
    })
    .select('*')
    .single();

  if (profErr) {
    await adminClient.auth.admin.deleteUser(createdAuth.user.id);
    return NextResponse.json({ error: profErr.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'staff_created',
    entity_type: 'profile',
    entity_id: profile.id,
    new_data: { email, full_name, role },
  });

  return NextResponse.json({ member: { ...profile, email } }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = teamPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const { id, role, active, full_name } = parsed.data;

  if (id === user.id && (active === false || role === 'employee')) {
    return NextResponse.json(
      { error: 'No puedes desactivar o degradar tu propia cuenta de administrador.' },
      { status: 400 },
    );
  }

  const { data: current } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!current) {
    return NextResponse.json({ error: 'Usuario no encontrado.' }, { status: 404 });
  }

  if ((active === false || role === 'employee') && current.role === 'admin') {
    const { count } = await adminClient
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('active', true);

    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: 'Debe permanecer al menos un administrador activo en el sistema.' },
        { status: 400 },
      );
    }
  }

  const updates: Record<string, unknown> = {};
  if (role !== undefined) updates.role = role;
  if (active !== undefined) updates.active = active;
  if (full_name !== undefined) updates.full_name = full_name;

  const { data: updated, error } = await adminClient
    .from('profiles')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'staff_updated',
    entity_type: 'profile',
    entity_id: id,
    old_data: current,
    new_data: updated,
  });

  return NextResponse.json({ member: updated });
}
