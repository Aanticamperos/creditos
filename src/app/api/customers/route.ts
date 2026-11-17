import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import { computeEffectiveInstallmentStatus, getLoanCurrentCapital } from '@/lib/financial';
import { customerCreateSchema, firstZodError } from '@/lib/validation';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const includeArchived = request.nextUrl.searchParams.get('includeArchived') === 'true';
  const { adminClient } = auth.ctx;

  let query = adminClient
    .from('customers')
    .select(
      'id, document_type, document_number, first_names, last_names, phone, email, address, notes, archived_at, created_at',
    )
    .order('created_at', { ascending: false });

  if (!includeArchived) {
    query = query.is('archived_at', null);
  }

  const [{ data: customers, error: custErr }, { data: loans }, { data: installments }] =
    await Promise.all([
      query,
      adminClient
        .from('loans')
        .select('id, customer_id, status, capital, contractual_total, terms_snapshot')
        .neq('status', 'archived'),
      adminClient
        .from('loan_installments')
        .select('loan_id, original_amount, paid_amount, due_date'),
    ]);

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const today = todayBogota();
  const loanMap = new Map<string, { customer_id: string; status: string }>();
  const summaryByCustomer = new Map<
    string,
    {
      active_loans: number;
      total_loans: number;
      pending_balance: number;
      overdue_installments: number;
    }
  >();

  for (const loan of loans ?? []) {
    loanMap.set(loan.id, { customer_id: loan.customer_id, status: loan.status });
    const entry = summaryByCustomer.get(loan.customer_id) ?? {
      active_loans: 0,
      total_loans: 0,
      pending_balance: 0,
      overdue_installments: 0,
    };
    entry.total_loans += 1;
    if (loan.status === 'active' || loan.status === 'blocked') {
      entry.active_loans += 1;
    }
    entry.pending_balance += getLoanCurrentCapital(loan);
    summaryByCustomer.set(loan.customer_id, entry);
  }

  for (const inst of installments ?? []) {
    const loan = loanMap.get(inst.loan_id);
    if (!loan || loan.status === 'draft') continue;
    const entry = summaryByCustomer.get(loan.customer_id);
    if (!entry) continue;
    const remaining = Math.max(0, Number(inst.original_amount) - Number(inst.paid_amount));
    entry.pending_balance += remaining;
    const eff = computeEffectiveInstallmentStatus({
      original_amount: Number(inst.original_amount),
      paid_amount: Number(inst.paid_amount),
      due_date: inst.due_date,
      today,
    });
    if (eff === 'overdue' || eff === 'overdue_partial') {
      entry.overdue_installments += 1;
    }
  }

  const enriched = (customers ?? []).map((c) => ({
    ...c,
    summary: summaryByCustomer.get(c.id) ?? {
      active_loans: 0,
      total_loans: 0,
      pending_balance: 0,
      overdue_installments: 0,
    },
  }));

  return NextResponse.json({ customers: enriched });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = customerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const payload = {
    document_type: parsed.data.document_type,
    document_number: parsed.data.document_number,
    first_names: parsed.data.first_names,
    last_names: parsed.data.last_names,
    phone: parsed.data.phone,
    email: parsed.data.email ? parsed.data.email : null,
    address: parsed.data.address ? parsed.data.address : null,
    notes: parsed.data.notes ? parsed.data.notes : null,
    created_by: user.id,
  };

  const { data, error } = await adminClient
    .from('customers')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Ese número de documento ya está registrado en el sistema.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'customer_created',
    entity_type: 'customer',
    entity_id: data.id,
    new_data: {
      document_type: data.document_type,
      document_number: data.document_number,
      name: `${data.first_names} ${data.last_names}`,
    },
  });

  return NextResponse.json({ customer: data }, { status: 201 });
}
