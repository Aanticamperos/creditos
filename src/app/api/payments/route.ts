import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { nextCalendarMonthDate, todayBogota } from '@/lib/dates';
import {
  getLoanBillingMode,
  getLoanCurrentCapital,
  shiftToWorkingDay,
  type LoanTermsSnapshot,
} from '@/lib/financial';
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

  const [{ data: payments, error }, { data: customers }, { data: profiles }, { data: capAdjustments }] =
    await Promise.all([
      query,
      adminClient
        .from('customers')
        .select('id, document_type, document_number, first_names, last_names, phone'),
      adminClient.from('profiles').select('id, full_name'),
      adminClient
        .from('financial_adjustments')
        .select('id, loan_id, amount, original_data')
        .eq('adjustment_type', 'capital_payment'),
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

  const capByPayment = new Map<string, { id: string; loan_id: string; amount: number }[]>();
  for (const adj of capAdjustments ?? []) {
    const pid = (adj.original_data as { payment_id?: string } | null)?.payment_id;
    if (!pid) continue;
    const arr = capByPayment.get(pid) ?? [];
    arr.push({ id: adj.id, loan_id: adj.loan_id, amount: Number(adj.amount) });
    capByPayment.set(pid, arr);
  }

  const enriched = (payments ?? []).map((p) => ({
    ...p,
    customer: customerMap.get(p.customer_id) ?? null,
    collector_name: profileMap.get(p.received_by)?.full_name ?? 'Personal autorizado',
    allocations: allocsByPayment.get(p.id) ?? [],
    capital_payments: capByPayment.get(p.id) ?? [],
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
  const capSumMap = new Map<string, number>();
  for (const c of input.capital_payments) {
    capSumMap.set(c.loan_id, (capSumMap.get(c.loan_id) ?? 0) + c.amount);
  }

  const instIds = Array.from(instSumMap.keys());
  const penIds = Array.from(penSumMap.keys());

  interface InstallmentRow {
    id: string;
    loan_id: string;
    installment_number: number;
    scheduled_due_date: string;
    due_date: string;
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

  if (targetInstallments.length !== instIds.length) {
    return NextResponse.json(
      { error: 'Una o más cuotas seleccionadas no existen.' },
      { status: 400 },
    );
  }
  if (targetPenalties.length !== penIds.length) {
    return NextResponse.json(
      { error: 'Una o más penalizaciones seleccionadas no existen.' },
      { status: 400 },
    );
  }

  const penInstIds = targetPenalties.map((p) => p.installment_id);
  const { data: penInstallments } = penInstIds.length
    ? await adminClient.from('loan_installments').select('id, loan_id').in('id', penInstIds)
    : { data: [] };

  const allLoanIds = Array.from(
    new Set([
      ...targetInstallments.map((i) => i.loan_id),
      ...(penInstallments ?? []).map((i) => i.loan_id),
      ...Array.from(capSumMap.keys()),
    ]),
  );

  const { data: loans } = allLoanIds.length
    ? await adminClient
        .from('loans')
        .select('*')
        .in('id', allLoanIds)
    : { data: [] };

  const loanMap = new Map((loans ?? []).map((l) => [l.id, l]));
  if (loanMap.size !== allLoanIds.length) {
    return NextResponse.json({ error: 'Uno de los préstamos no existe.' }, { status: 404 });
  }

  for (const loan of loans ?? []) {
    if (loan.customer_id !== input.customer_id) {
      return NextResponse.json(
        { error: 'Las cuotas o abonos no pertenecen al cliente seleccionado.' },
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

  for (const inst of targetInstallments) {
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
  for (const pen of targetPenalties) {
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

  for (const [loanId, capAmt] of capSumMap.entries()) {
    const loan = loanMap.get(loanId);
    if (!loan || getLoanBillingMode(loan.terms_snapshot) !== 'monthly_interest_only') {
      return NextResponse.json(
        { error: 'Los abonos directos a capital aplican a préstamos mensuales sobre saldo.' },
        { status: 400 },
      );
    }
    const currentCap = getLoanCurrentCapital(loan);
    if (capAmt > currentCap) {
      return NextResponse.json(
        { error: 'El abono a capital supera el capital pendiente del préstamo.' },
        { status: 400 },
      );
    }
  }

  const totalAmount =
    Array.from(instSumMap.values()).reduce((s, n) => s + n, 0) +
    Array.from(penSumMap.values()).reduce((s, n) => s + n, 0) +
    Array.from(capSumMap.values()).reduce((s, n) => s + n, 0);

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

  if (allocRows.length > 0) {
    const { error: allocErr } = await adminClient.from('payment_allocations').insert(allocRows);
    if (allocErr) {
      await adminClient.from('payments').delete().eq('id', paymentId);
      return NextResponse.json({ error: allocErr.message }, { status: 500 });
    }
  }

  const updatedInstSnapshots: InstallmentRow[] = [];
  const updatedPenSnapshots: PenaltyRow[] = [];
  const updatedLoanSnapshots: { id: string; terms_snapshot: unknown }[] = [];

  try {
    for (const inst of targetInstallments) {
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

    for (const pen of targetPenalties) {
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

    for (const [loanId, capAmt] of capSumMap.entries()) {
      const loan = loanMap.get(loanId)!;
      const prevSnap = (loan.terms_snapshot ?? {}) as LoanTermsSnapshot;
      const prevCurrent = Number(prevSnap.current_capital ?? loan.capital);
      const newCurrent = Math.max(0, prevCurrent - capAmt);
      const nextSnap: LoanTermsSnapshot = {
        ...prevSnap,
        current_capital: newCurrent,
        capital_paid: Number(prevSnap.capital_paid ?? 0) + capAmt,
      };

      const { error: capUpdErr } = await adminClient
        .from('loans')
        .update({ terms_snapshot: nextSnap })
        .eq('id', loanId);
      if (capUpdErr) throw new Error(capUpdErr.message);

      updatedLoanSnapshots.push({ id: loanId, terms_snapshot: loan.terms_snapshot });
      loan.terms_snapshot = nextSnap;

      const { error: adjErr } = await adminClient.from('financial_adjustments').insert({
        loan_id: loanId,
        adjustment_type: 'capital_payment',
        amount: capAmt,
        reason: 'Abono a capital en pago recibido',
        original_data: {
          payment_id: paymentId,
          prev_capital: prevCurrent,
          new_capital: newCurrent,
        },
        created_by: user.id,
      });
      if (adjErr) throw new Error(adjErr.message);
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
        capital_payments_count: capSumMap.size,
      },
    });
  } catch (err) {
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
    for (const snap of updatedLoanSnapshots) {
      await adminClient
        .from('loans')
        .update({ terms_snapshot: snap.terms_snapshot })
        .eq('id', snap.id);
    }
    await adminClient
      .from('financial_adjustments')
      .delete()
      .eq('adjustment_type', 'capital_payment')
      .contains('original_data', { payment_id: paymentId });
    await adminClient.from('payment_allocations').delete().eq('payment_id', paymentId);
    await adminClient.from('payments').delete().eq('id', paymentId);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error aplicando el pago.' },
      { status: 409 },
    );
  }

  // Post-payment lifecycle: renew monthly_interest_only cycle OR auto-finish loans
  const finishedLoans: string[] = [];
  const generatedCycles: { loan_id: string; due_date: string; amount: number }[] = [];
  const today = todayBogota();
  const { data: holidays } = await adminClient.from('business_holidays').select('holiday_date');
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);

  for (const loanId of allLoanIds) {
    const loan = loanMap.get(loanId)!;
    const billingMode = getLoanBillingMode(loan.terms_snapshot);
    const currentCapital = getLoanCurrentCapital(loan);

    const { data: loanInsts } = await adminClient
      .from('loan_installments')
      .select('id, installment_number, scheduled_due_date, due_date, original_amount, paid_amount')
      .eq('loan_id', loanId)
      .order('installment_number', { ascending: true });

    const unpaidInsts = (loanInsts ?? []).filter(
      (i) => Number(i.paid_amount) < Number(i.original_amount),
    );
    const lInstIds = (loanInsts ?? []).map((i) => i.id);
    const { data: loanPens } = lInstIds.length
      ? await adminClient
          .from('late_penalties')
          .select('amount, paid_amount')
          .in('installment_id', lInstIds)
      : { data: [] };

    const penPending = (loanPens ?? []).some((p) => Number(p.paid_amount) < Number(p.amount));

    if (billingMode === 'monthly_interest_only') {
      // If capital dropped via capital_payment, adjust any untouched future cycle
      if (capSumMap.has(loanId) && currentCapital > 0) {
        const newInterest = Math.max(
          1,
          Math.round((currentCapital * Number(loan.interest_rate)) / 100),
        );
        for (const ui of unpaidInsts) {
          if (Number(ui.paid_amount) === 0 && ui.scheduled_due_date > today) {
            await adminClient
              .from('loan_installments')
              .update({ original_amount: newInterest })
              .eq('id', ui.id);
          }
        }
      }

      if (currentCapital === 0 && unpaidInsts.length === 0 && !penPending) {
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
      } else if (currentCapital > 0 && unpaidInsts.length === 0) {
        // Automatically generate next monthly interest cycle anchored to billing_day!
        const lastInst = (loanInsts ?? [])[(loanInsts ?? []).length - 1];
        const snap = (loan.terms_snapshot ?? {}) as LoanTermsSnapshot;
        const billingDay = Number(
          snap.billing_day ?? Number((lastInst?.scheduled_due_date ?? today).slice(8, 10)),
        );
        const nextScheduled = nextCalendarMonthDate(
          lastInst?.scheduled_due_date ?? today,
          billingDay,
        );
        const nextDue = shiftToWorkingDay(nextScheduled, holidayDates);
        const nextAmount = Math.max(
          1,
          Math.round((currentCapital * Number(loan.interest_rate)) / 100),
        );
        const nextNumber = (lastInst?.installment_number ?? 0) + 1;

        const { error: nextErr } = await adminClient.from('loan_installments').insert({
          loan_id: loanId,
          installment_number: nextNumber,
          scheduled_due_date: nextScheduled,
          due_date: nextDue,
          original_amount: nextAmount,
          paid_amount: 0,
          status: 'pending',
          penalty_frozen: false,
        });

        if (!nextErr) {
          await adminClient
            .from('loans')
            .update({
              installments_count: nextNumber,
              contractual_interest: Number(loan.contractual_interest) + nextAmount,
              contractual_total: Number(loan.contractual_total) + nextAmount,
              terms_snapshot: { ...snap, next_cycle_date: nextScheduled },
            })
            .eq('id', loanId);

          generatedCycles.push({ loan_id: loanId, due_date: nextDue, amount: nextAmount });
          await writeAuditLog(adminClient, {
            actor_id: user.id,
            action: 'monthly_interest_cycle_generated',
            entity_type: 'loan',
            entity_id: loanId,
            new_data: {
              installment_number: nextNumber,
              due_date: nextDue,
              amount: nextAmount,
              capital_base: currentCapital,
            },
          });
        }
      }
      continue;
    }

    // Standard fixed_installments auto-finish
    if (unpaidInsts.length === 0 && !penPending) {
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
      capital_payments: Array.from(capSumMap.entries()).map(([loan_id, amount]) => ({
        loan_id,
        amount,
      })),
      customer,
      business_profile: settings.business_profile,
      finished_loans: finishedLoans,
      generated_cycles: generatedCycles,
    },
    { status: 201 },
  );
}
