import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { loadAppSettings } from '@/lib/settings';
import { firstZodError, paymentCreateSchema } from '@/lib/validation';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const customerId = request.nextUrl.searchParams.get('customerId');
  const limit = Math.min(300, Math.max(10, Number(request.nextUrl.searchParams.get('limit') ?? 120)));
  const { adminClient } = auth.ctx;

  let query = adminClient
    .from('payments')
    .select('*')
    .order('received_at', { ascending: false })
    .limit(limit);

  if (customerId) {
    query = query.eq('customer_id', customerId);
  }

  const [{ data: payments, error }, { data: customers }, { data: profiles }] = await Promise.all([
    query,
    adminClient
      .from('customers')
      .select('id, document_type, document_number, first_names, last_names, phone'),
    adminClient.from('profiles').select('id, full_name'),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const paymentIds = (payments ?? []).map((p) => p.id);
  const { data: allocations } = paymentIds.length
    ? await adminClient.from('payment_allocations').select('*').in('payment_id', paymentIds)
    : { data: [] };

  const installmentIds = Array.from(
    new Set((allocations ?? []).map((a) => a.installment_id).filter(Boolean) as string[]),
  );
  const penaltyIds = Array.from(
    new Set((allocations ?? []).map((a) => a.penalty_id).filter(Boolean) as string[]),
  );

  const [{ data: installments }, { data: penalties }] = await Promise.all([
    installmentIds.length
      ? adminClient
          .from('loan_installments')
          .select('id, loan_id, installment_number, due_date')
          .in('id', installmentIds)
      : Promise.resolve({ data: [] }),
    penaltyIds.length
      ? adminClient
          .from('late_penalties')
          .select('id, installment_id, period_number')
          .in('id', penaltyIds)
      : Promise.resolve({ data: [] }),
  ]);

  const customerMap = new Map((customers ?? []).map((c) => [c.id, c]));
  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const instMap = new Map((installments ?? []).map((i) => [i.id, i]));
  const penMap = new Map((penalties ?? []).map((p) => [p.id, p]));

  const allocsByPayment = new Map<string, Record<string, unknown>[]>();
  for (const a of allocations ?? []) {
    const arr = allocsByPayment.get(a.payment_id) ?? [];
    arr.push({
      ...a,
      installment: a.installment_id ? instMap.get(a.installment_id) ?? null : null,
      penalty: a.penalty_id ? penMap.get(a.penalty_id) ?? null : null,
    });
    allocsByPayment.set(a.payment_id, arr);
  }

  const enriched = (payments ?? []).map((p) => ({
    ...p,
    customer: customerMap.get(p.customer_id) ?? null,
    collector_name: profileMap.get(p.received_by)?.full_name ?? 'Personal autorizado',
    allocations: allocsByPayment.get(p.id) ?? [],
  }));

  return NextResponse.json({ payments: enriched });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const input = parsed.data;
  const idempotencyKey = input.idempotency_key ?? crypto.randomUUID();

  // Check idempotency first
  const { data: existingPayment } = await adminClient
    .from('payments')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingPayment) {
    const [{ data: customer }, { data: existingAllocs }, settings] = await Promise.all([
      adminClient.from('customers').select('*').eq('id', existingPayment.customer_id).maybeSingle(),
      adminClient.from('payment_allocations').select('*').eq('payment_id', existingPayment.id),
      loadAppSettings(adminClient),
    ]);
    return NextResponse.json({
      payment: existingPayment,
      allocations: existingAllocs ?? [],
      customer,
      business_profile: settings.business_profile,
      deduplicated: true,
    });
  }

  const { data: customer } = await adminClient
    .from('customers')
    .select('*')
    .eq('id', input.customer_id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: 'Cliente no encontrado.' }, { status: 404 });
  }

  // Merge duplicate targets defensively
  const instSumMap = new Map<string, number>();
  for (const a of input.installment_allocations) {
    instSumMap.set(a.installment_id, (instSumMap.get(a.installment_id) ?? 0) + a.amount);
  }
  const penSumMap = new Map<string, number>();
  for (const p of input.penalty_allocations) {
    penSumMap.set(p.penalty_id, (penSumMap.get(p.penalty_id) ?? 0) + p.amount);
  }

  const instIds = Array.from(instSumMap.keys());
  const penIds = Array.from(penSumMap.keys());

  interface InstallmentRow {
    id: string;
    loan_id: string;
    installment_number: number;
    original_amount: number;
    paid_amount: number;
    last_payment_at: string | null;
    penalty_frozen: boolean;
    status: string;
  }

  interface PenaltyRow {
    id: string;
    installment_id: string;
    amount: number;
    paid_amount: number;
  }

  const [{ data: rawInstallments }, { data: rawPenalties }] = await Promise.all([
    instIds.length
      ? adminClient.from('loan_installments').select('*').in('id', instIds)
      : Promise.resolve({ data: [] as InstallmentRow[] }),
    penIds.length
      ? adminClient.from('late_penalties').select('*').in('id', penIds)
      : Promise.resolve({ data: [] as PenaltyRow[] }),
  ]);

  const targetInstallments = (rawInstallments ?? []) as InstallmentRow[];
  const targetPenalties = (rawPenalties ?? []) as PenaltyRow[];

  if ((targetInstallments ?? []).length !== instIds.length) {
    return NextResponse.json(
      { error: 'Una o más cuotas seleccionadas no existen.' },
      { status: 400 },
    );
  }
  if ((targetPenalties ?? []).length !== penIds.length) {
    return NextResponse.json(
      { error: 'Una o más penalizaciones seleccionadas no existen.' },
      { status: 400 },
    );
  }

  const penInstIds = (targetPenalties ?? []).map((p) => p.installment_id);
  const { data: penInstallments } = penInstIds.length
    ? await adminClient.from('loan_installments').select('id, loan_id').in('id', penInstIds)
    : { data: [] };

  const allLoanIds = Array.from(
    new Set([
      ...(targetInstallments ?? []).map((i) => i.loan_id),
      ...(penInstallments ?? []).map((i) => i.loan_id),
    ]),
  );

  const { data: loans } = allLoanIds.length
    ? await adminClient
        .from('loans')
        .select('id, customer_id, status')
        .in('id', allLoanIds)
    : { data: [] };

  const loanMap = new Map((loans ?? []).map((l) => [l.id, l]));
  for (const loan of loans ?? []) {
    if (loan.customer_id !== input.customer_id) {
      return NextResponse.json(
        { error: 'Las cuotas asignadas no pertenecen al cliente seleccionado.' },
        { status: 400 },
      );
    }
    if (loan.status === 'draft' || loan.status === 'archived') {
      return NextResponse.json(
        { error: 'No es posible registrar pagos sobre préstamos en borrador o archivados.' },
        { status: 400 },
      );
    }
  }

  for (const inst of targetInstallments ?? []) {
    const reqAmt = instSumMap.get(inst.id) ?? 0;
    const rem = Number(inst.original_amount) - Number(inst.paid_amount);
    if (reqAmt > rem) {
      return NextResponse.json(
        { error: `El monto asignado a la cuota #${inst.installment_number} supera su saldo pendiente.` },
        { status: 400 },
      );
    }
  }

  const penInstLoanMap = new Map((penInstallments ?? []).map((i) => [i.id, i.loan_id]));
  for (const pen of targetPenalties ?? []) {
    const loanId = penInstLoanMap.get(pen.installment_id);
    if (!loanId || !loanMap.has(loanId)) {
      return NextResponse.json(
        { error: 'La penalización seleccionada no pertenece al cliente.' },
        { status: 400 },
      );
    }
    const reqAmt = penSumMap.get(pen.id) ?? 0;
    const rem = Number(pen.amount) - Number(pen.paid_amount);
    if (reqAmt > rem) {
      return NextResponse.json(
        { error: 'El monto asignado a una penalización supera su saldo pendiente.' },
        { status: 400 },
      );
    }
  }

  const totalAmount =
    Array.from(instSumMap.values()).reduce((s, n) => s + n, 0) +
    Array.from(penSumMap.values()).reduce((s, n) => s + n, 0);

  // Unified verified ledger execution with optimistic concurrency guard & compensating rollback
  const { data: paymentRow, error: payErr } = await adminClient
    .from('payments')
    .insert({
      customer_id: input.customer_id,
      received_amount: totalAmount,
      method: input.method,
      transfer_reference:
        input.method === 'transfer' ? input.transfer_reference?.trim() ?? null : null,
      notes: input.notes ? input.notes : null,
      received_by: user.id,
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();

  if (payErr || !paymentRow) {
    return NextResponse.json(
      { error: payErr?.message ?? 'No fue posible registrar el pago.' },
      { status: 500 },
    );
  }

  const paymentId = paymentRow.id;
  const allocRows = [
    ...Array.from(instSumMap.entries()).map(([installment_id, amount]) => ({
      payment_id: paymentId,
      installment_id,
      penalty_id: null,
      amount,
    })),
    ...Array.from(penSumMap.entries()).map(([penalty_id, amount]) => ({
      payment_id: paymentId,
      installment_id: null,
      penalty_id,
      amount,
    })),
  ];

  const { error: allocErr } = await adminClient.from('payment_allocations').insert(allocRows);
  if (allocErr) {
    await adminClient.from('payments').delete().eq('id', paymentId);
    return NextResponse.json({ error: allocErr.message }, { status: 500 });
  }

  const updatedInstSnapshots: InstallmentRow[] = [];
  const updatedPenSnapshots: PenaltyRow[] = [];

  try {
    for (const inst of targetInstallments ?? []) {
      const addAmt = instSumMap.get(inst.id) ?? 0;
      const newPaid = Number(inst.paid_amount) + addAmt;
      const orig = Number(inst.original_amount);
      const nextStatus = newPaid >= orig ? 'paid' : 'partial';

      const { data: updatedRow, error: updInstErr } = await adminClient
        .from('loan_installments')
        .update({
          paid_amount: newPaid,
          last_payment_at: new Date().toISOString(),
          penalty_frozen: true,
          status: nextStatus,
        })
        .eq('id', inst.id)
        .eq('paid_amount', inst.paid_amount)
        .select('id')
        .maybeSingle();

      if (updInstErr) throw new Error(updInstErr.message);
      if (!updatedRow) {
        throw new Error(
          `El saldo de la cuota #${inst.installment_number} cambió simultáneamente. Recarga e intenta de nuevo.`,
        );
      }
      updatedInstSnapshots.push(inst);
    }

    for (const pen of targetPenalties ?? []) {
      const addAmt = penSumMap.get(pen.id) ?? 0;
      const newPaid = Number(pen.paid_amount) + addAmt;
      const { data: updatedPen, error: updPenErr } = await adminClient
        .from('late_penalties')
        .update({ paid_amount: newPaid })
        .eq('id', pen.id)
        .eq('paid_amount', pen.paid_amount)
        .select('id')
        .maybeSingle();

      if (updPenErr) throw new Error(updPenErr.message);
      if (!updatedPen) {
        throw new Error('El saldo de una penalización cambió simultáneamente. Recarga e intenta de nuevo.');
      }
      updatedPenSnapshots.push(pen);
    }

    await writeAuditLog(adminClient, {
      actor_id: user.id,
      action: 'payment_registered',
      entity_type: 'payment',
      entity_id: paymentId,
      new_data: {
        amount: totalAmount,
        method: input.method,
        installments_count: instSumMap.size,
        penalties_count: penSumMap.size,
      },
    });
  } catch (err) {
    // Compensating rollback only on rows mutated by this request
    for (const inst of updatedInstSnapshots) {
      await adminClient
        .from('loan_installments')
        .update({
          paid_amount: inst.paid_amount,
          last_payment_at: inst.last_payment_at,
          penalty_frozen: inst.penalty_frozen,
          status: inst.status,
        })
        .eq('id', inst.id);
    }
    for (const pen of updatedPenSnapshots) {
      await adminClient
        .from('late_penalties')
        .update({ paid_amount: pen.paid_amount })
        .eq('id', pen.id);
    }
    await adminClient.from('payment_allocations').delete().eq('payment_id', paymentId);
    await adminClient.from('payments').delete().eq('id', paymentId);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error aplicando el pago.' },
      { status: 409 },
    );
  }

  // Auto-finish loans whose installments and penalties are completely paid
  const finishedLoans: string[] = [];
  for (const loanId of allLoanIds) {
    const { data: loanInsts } = await adminClient
      .from('loan_installments')
      .select('id, original_amount, paid_amount')
      .eq('loan_id', loanId);

    const instPending = (loanInsts ?? []).some(
      (i) => Number(i.paid_amount) < Number(i.original_amount),
    );
    if (instPending) continue;

    const lInstIds = (loanInsts ?? []).map((i) => i.id);
    const { data: loanPens } = lInstIds.length
      ? await adminClient
          .from('late_penalties')
          .select('amount, paid_amount')
          .in('installment_id', lInstIds)
      : { data: [] };

    const penPending = (loanPens ?? []).some((p) => Number(p.paid_amount) < Number(p.amount));
    if (!penPending) {
      const { error: finishErr } = await adminClient
        .from('loans')
        .update({ status: 'finished' })
        .eq('id', loanId)
        .in('status', ['active', 'blocked']);

      if (!finishErr) {
        finishedLoans.push(loanId);
        await writeAuditLog(adminClient, {
          actor_id: user.id,
          action: 'loan_finished_auto',
          entity_type: 'loan',
          entity_id: loanId,
          new_data: { trigger_payment_id: paymentId },
        });
      }
    }
  }

  const [{ data: finalPayment }, { data: finalAllocs }, settings] = await Promise.all([
    adminClient.from('payments').select('*').eq('id', paymentId).single(),
    adminClient.from('payment_allocations').select('*').eq('payment_id', paymentId),
    loadAppSettings(adminClient),
  ]);

  return NextResponse.json(
    {
      payment: finalPayment,
      allocations: finalAllocs ?? [],
      customer,
      business_profile: settings.business_profile,
      finished_loans: finishedLoans,
    },
    { status: 201 },
  );
}
