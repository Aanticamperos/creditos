import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  computeEquivalentRates,
  quote,
  schedule,
  type Frequency,
} from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';
import { firstZodError, loanCreateSchema } from '@/lib/validation';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const statusFilter = request.nextUrl.searchParams.get('status');
  const customerId = request.nextUrl.searchParams.get('customerId');
  const { adminClient } = auth.ctx;

  let query = adminClient
    .from('loans')
    .select('*')
    .order('created_at', { ascending: false });

  if (statusFilter && statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }
  if (customerId) {
    query = query.eq('customer_id', customerId);
  }

  const [{ data: loans, error }, { data: customers }, { data: installments }, { data: penalties }] =
    await Promise.all([
      query,
      adminClient
        .from('customers')
        .select('id, document_type, document_number, first_names, last_names, phone'),
      adminClient
        .from('loan_installments')
        .select('id, loan_id, installment_number, due_date, original_amount, paid_amount, status'),
      adminClient.from('late_penalties').select('installment_id, amount, paid_amount'),
    ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const customerMap = new Map((customers ?? []).map((c) => [c.id, c]));
  const penaltiesByInst = new Map<string, number>();
  for (const p of penalties ?? []) {
    const rem = Math.max(0, Number(p.amount) - Number(p.paid_amount));
    penaltiesByInst.set(p.installment_id, (penaltiesByInst.get(p.installment_id) ?? 0) + rem);
  }

  const today = todayBogota();
  const instStats = new Map<
    string,
    {
      total_paid: number;
      installments_remaining: number;
      penalties_remaining: number;
      overdue_count: number;
      paid_count: number;
      next_due_date: string | null;
    }
  >();

  for (const inst of installments ?? []) {
    const entry = instStats.get(inst.loan_id) ?? {
      total_paid: 0,
      installments_remaining: 0,
      penalties_remaining: 0,
      overdue_count: 0,
      paid_count: 0,
      next_due_date: null,
    };

    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    const rem = Math.max(0, orig - paid);
    entry.total_paid += paid;
    entry.installments_remaining += rem;
    entry.penalties_remaining += penaltiesByInst.get(inst.id) ?? 0;

    const eff = computeEffectiveInstallmentStatus({
      original_amount: orig,
      paid_amount: paid,
      due_date: inst.due_date,
      today,
    });

    if (eff === 'paid') {
      entry.paid_count += 1;
    } else {
      if (!entry.next_due_date || inst.due_date < entry.next_due_date) {
        entry.next_due_date = inst.due_date;
      }
      if (eff === 'overdue' || eff === 'overdue_partial') {
        entry.overdue_count += 1;
      }
    }
    instStats.set(inst.loan_id, entry);
  }

  const enriched = (loans ?? []).map((loan) => {
    const stats = instStats.get(loan.id) ?? {
      total_paid: 0,
      installments_remaining: Number(loan.contractual_total),
      penalties_remaining: 0,
      overdue_count: 0,
      paid_count: 0,
      next_due_date: null,
    };
    return {
      ...loan,
      customer: customerMap.get(loan.customer_id) ?? null,
      ...stats,
    };
  });

  return NextResponse.json({ loans: enriched });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = loanCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const input = parsed.data;

  const { data: customer, error: custErr } = await adminClient
    .from('customers')
    .select('id, archived_at, first_names, last_names')
    .eq('id', input.customer_id)
    .maybeSingle();

  if (custErr || !customer) {
    return NextResponse.json({ error: 'Cliente no encontrado.' }, { status: 404 });
  }
  if (customer.archived_at) {
    return NextResponse.json(
      { error: 'No se puede crear un préstamo para un cliente archivado.' },
      { status: 400 },
    );
  }

  const [{ data: holidays }, settings] = await Promise.all([
    adminClient.from('business_holidays').select('holiday_date'),
    loadAppSettings(adminClient),
  ]);

  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);
  const computedQuote = quote(input.capital, input.interest_rate, input.installments_count);
  const computedSchedule = schedule(
    input.first_payment_date,
    input.frequency as Frequency,
    input.installments_count,
    holidayDates,
  );
  const equivalent = computeEquivalentRates(
    input.interest_rate,
    input.frequency as Frequency,
    input.installments_count,
  );

  const reg = settings.regulatory_policy;
  if (
    input.initial_status === 'active' &&
    reg.configured &&
    reg.enforce_limit &&
    reg.max_ea_rate > 0 &&
    equivalent.eaEquivalent > reg.max_ea_rate
  ) {
    return NextResponse.json(
      {
        error: `La tasa equivalente (${equivalent.eaEquivalent}% EA) supera el tope regulatorio configurado (${reg.max_ea_rate}% EA). Ajusta las condiciones o guarda como borrador.`,
      },
      { status: 422 },
    );
  }

  const regulatorySnapshot = {
    configured: reg.configured,
    max_ea_rate: reg.max_ea_rate,
    max_monthly_rate: reg.max_monthly_rate,
    official_source: reg.official_source,
    effective_from: reg.effective_from,
    enforce_limit: reg.enforce_limit,
    loan_monthly_equivalent: equivalent.monthlyEquivalent,
    loan_ea_equivalent: equivalent.eaEquivalent,
    exceeds_configured_limit:
      reg.configured && reg.max_ea_rate > 0 ? equivalent.eaEquivalent > reg.max_ea_rate : false,
    captured_at: new Date().toISOString(),
  };

  const termsSnapshot = {
    capital: input.capital,
    interest_rate: input.interest_rate,
    contractual_interest: computedQuote.interest,
    contractual_total: computedQuote.total,
    frequency: input.frequency,
    installments_count: input.installments_count,
    holidays_applied_count: holidayDates.length,
    first_payment_date: input.first_payment_date,
    last_due_date: computedSchedule[computedSchedule.length - 1]?.due ?? input.first_payment_date,
  };

  const { data: loan, error: loanErr } = await adminClient
    .from('loans')
    .insert({
      customer_id: input.customer_id,
      capital: input.capital,
      interest_rate: input.interest_rate,
      contractual_interest: computedQuote.interest,
      contractual_total: computedQuote.total,
      frequency: input.frequency,
      installments_count: input.installments_count,
      disbursement_date: input.disbursement_date,
      first_payment_date: input.first_payment_date,
      notes: input.notes ? input.notes : null,
      status: input.initial_status,
      regulatory_snapshot: regulatorySnapshot,
      terms_snapshot: termsSnapshot,
      created_by: user.id,
    })
    .select('*')
    .single();

  if (loanErr || !loan) {
    return NextResponse.json(
      { error: loanErr?.message ?? 'Error al crear el préstamo.' },
      { status: 500 },
    );
  }

  const installmentRows = computedSchedule.map((item, idx) => ({
    loan_id: loan.id,
    installment_number: idx + 1,
    scheduled_due_date: item.scheduled,
    due_date: item.due,
    original_amount: computedQuote.values[idx],
    paid_amount: 0,
    status: 'pending',
    penalty_frozen: false,
  }));

  const { error: instErr } = await adminClient
    .from('loan_installments')
    .insert(installmentRows);

  if (instErr) {
    await adminClient.from('loans').delete().eq('id', loan.id);
    return NextResponse.json(
      { error: `No fue posible generar el calendario de cuotas: ${instErr.message}` },
      { status: 500 },
    );
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'loan_created',
    entity_type: 'loan',
    entity_id: loan.id,
    new_data: {
      customer_id: input.customer_id,
      capital: input.capital,
      total: computedQuote.total,
      installments_count: input.installments_count,
      frequency: input.frequency,
      status: input.initial_status,
    },
  });

  return NextResponse.json({ loan, installments_count: installmentRows.length }, { status: 201 });
}
