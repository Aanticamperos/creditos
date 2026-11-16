import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  computeEquivalentRates,
  computePenaltyDetails,
  type Frequency,
} from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';
import { firstZodError, loanPatchSchema } from '@/lib/validation';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const { adminClient } = auth.ctx;

  const { data: loan, error: loanErr } = await adminClient
    .from('loans')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (loanErr) {
    return NextResponse.json({ error: loanErr.message }, { status: 500 });
  }
  if (!loan) {
    return NextResponse.json({ error: 'Préstamo no encontrado.' }, { status: 404 });
  }

  const [
    { data: customer },
    { data: installments },
    { data: adjustments },
    { data: holidays },
    settings,
  ] = await Promise.all([
    adminClient.from('customers').select('*').eq('id', loan.customer_id).maybeSingle(),
    adminClient
      .from('loan_installments')
      .select('*')
      .eq('loan_id', id)
      .order('installment_number', { ascending: true }),
    adminClient
      .from('financial_adjustments')
      .select('*')
      .eq('loan_id', id)
      .order('created_at', { ascending: false }),
    adminClient.from('business_holidays').select('holiday_date'),
    loadAppSettings(adminClient),
  ]);

  const installmentIds = (installments ?? []).map((i) => i.id);
  const { data: penalties } = installmentIds.length
    ? await adminClient
        .from('late_penalties')
        .select('*')
        .in('installment_id', installmentIds)
        .order('period_number', { ascending: true })
    : { data: [] };

  const penaltyIds = (penalties ?? []).map((p) => p.id);
  const [allocByInstRes, allocByPenRes] = await Promise.all([
    installmentIds.length
      ? adminClient.from('payment_allocations').select('*').in('installment_id', installmentIds)
      : Promise.resolve({ data: [] }),
    penaltyIds.length
      ? adminClient.from('payment_allocations').select('*').in('penalty_id', penaltyIds)
      : Promise.resolve({ data: [] }),
  ]);

  const allocations = [...(allocByInstRes.data ?? []), ...(allocByPenRes.data ?? [])];
  const paymentIds = Array.from(new Set(allocations.map((a) => a.payment_id)));
  const { data: payments } = paymentIds.length
    ? await adminClient
        .from('payments')
        .select('*')
        .in('id', paymentIds)
        .order('received_at', { ascending: false })
    : { data: [] };

  const today = todayBogota();
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);

  const penaltiesByInst = new Map<string, typeof penalties>();
  for (const p of penalties ?? []) {
    const arr = penaltiesByInst.get(p.installment_id) ?? [];
    arr.push(p);
    penaltiesByInst.set(p.installment_id, arr);
  }

  let totalPaid = 0;
  let remainingInstallments = 0;
  let recordedPenaltiesPending = 0;
  let estimatedPenaltiesPending = 0;
  let overdueCount = 0;
  let paidCount = 0;

  const enrichedInstallments = (installments ?? []).map((inst) => {
    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    const remaining = Math.max(0, orig - paid);
    const instPenalties = penaltiesByInst.get(inst.id) ?? [];
    const recordedTotal = instPenalties.reduce((s, p) => s + Number(p.amount), 0);
    const recordedPaid = instPenalties.reduce((s, p) => s + Number(p.paid_amount), 0);
    const recordedRemaining = Math.max(0, recordedTotal - recordedPaid);

    const calc = computePenaltyDetails({
      originalAmount: orig,
      paidAmount: paid,
      dueDate: inst.due_date,
      today,
      holidays: holidayDates,
      penaltyFrozen: Boolean(inst.penalty_frozen),
      frequency: loan.frequency as Frequency,
      policy: settings.penalty_policy,
    });

    const effStatus = computeEffectiveInstallmentStatus({
      original_amount: orig,
      paid_amount: paid,
      due_date: inst.due_date,
      today,
    });

    totalPaid += paid;
    remainingInstallments += remaining;
    recordedPenaltiesPending += recordedRemaining;
    const unrecordedExtra = Math.max(0, calc.totalPenaltyAmount - recordedTotal);
    estimatedPenaltiesPending += recordedRemaining + unrecordedExtra;

    if (effStatus === 'paid') paidCount += 1;
    if (effStatus === 'overdue' || effStatus === 'overdue_partial') overdueCount += 1;

    return {
      ...inst,
      effective_status: effStatus,
      remaining_amount: remaining,
      days_late: calc.daysLate,
      penalties: instPenalties,
      recorded_penalties_remaining: recordedRemaining,
      estimated_penalty_total: Math.max(recordedTotal, calc.totalPenaltyAmount),
      estimated_penalties_remaining: recordedRemaining + unrecordedExtra,
    };
  });

  const allocationsByPayment = new Map<string, typeof allocations>();
  for (const a of allocations) {
    const arr = allocationsByPayment.get(a.payment_id) ?? [];
    arr.push(a);
    allocationsByPayment.set(a.payment_id, arr);
  }

  const enrichedPayments = (payments ?? []).map((p) => ({
    ...p,
    allocations: allocationsByPayment.get(p.id) ?? [],
  }));

  return NextResponse.json({
    loan,
    customer,
    installments: enrichedInstallments,
    payments: enrichedPayments,
    adjustments: adjustments ?? [],
    settings,
    summary: {
      totalPaid,
      remainingInstallments,
      recordedPenaltiesPending,
      estimatedPenaltiesPending,
      totalRemaining: remainingInstallments + recordedPenaltiesPending,
      overdueCount,
      paidCount,
      installmentsCount: enrichedInstallments.length,
    },
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = loanPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, profile, user } = auth.ctx;
  const { data: loan, error: loanErr } = await adminClient
    .from('loans')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (loanErr || !loan) {
    return NextResponse.json({ error: 'Préstamo no encontrado.' }, { status: 404 });
  }

  const payload = parsed.data;

  if (payload.action === 'update_notes') {
    const { data: updated, error } = await adminClient
      .from('loans')
      .update({ notes: payload.notes })
      .eq('id', id)
      .select('*')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await writeAuditLog(adminClient, {
      actor_id: user.id,
      action: 'loan_notes_updated',
      entity_type: 'loan',
      entity_id: id,
      old_data: { notes: loan.notes },
      new_data: { notes: updated.notes },
    });

    return NextResponse.json({ loan: updated });
  }

  if (payload.action === 'toggle_penalty_freeze') {
    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Solo un administrador puede congelar o reactivar mora manualmente.' },
        { status: 403 },
      );
    }

    const { data: inst, error: instErr } = await adminClient
      .from('loan_installments')
      .update({ penalty_frozen: payload.penalty_frozen })
      .eq('id', payload.installment_id)
      .eq('loan_id', id)
      .select('*')
      .maybeSingle();

    if (instErr || !inst) {
      return NextResponse.json({ error: 'Cuota no encontrada en este préstamo.' }, { status: 404 });
    }

    await writeAuditLog(adminClient, {
      actor_id: user.id,
      action: payload.penalty_frozen ? 'installment_penalty_frozen' : 'installment_penalty_unfrozen',
      entity_type: 'loan_installment',
      entity_id: inst.id,
      new_data: { penalty_frozen: payload.penalty_frozen, loan_id: id },
      reason: payload.reason ?? null,
    });

    return NextResponse.json({ installment: inst });
  }

  // change_status
  const targetStatus = payload.status;
  if (targetStatus === 'blocked' || targetStatus === 'archived' || (loan.status === 'blocked' && targetStatus === 'active')) {
    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Solo un administrador puede cambiar el estado a bloqueado o archivado.' },
        { status: 403 },
      );
    }
  }

  const [{ data: installments }, settings] = await Promise.all([
    adminClient.from('loan_installments').select('id, original_amount, paid_amount').eq('loan_id', id),
    loadAppSettings(adminClient),
  ]);

  const instIds = (installments ?? []).map((i) => i.id);
  const { data: penalties } = instIds.length
    ? await adminClient.from('late_penalties').select('amount, paid_amount').in('installment_id', instIds)
    : { data: [] };

  const pendingInstBalance = (installments ?? []).reduce(
    (s, i) => s + Math.max(0, Number(i.original_amount) - Number(i.paid_amount)),
    0,
  );
  const pendingPenBalance = (penalties ?? []).reduce(
    (s, p) => s + Math.max(0, Number(p.amount) - Number(p.paid_amount)),
    0,
  );

  if (targetStatus === 'finished' && pendingInstBalance + pendingPenBalance > 0) {
    return NextResponse.json(
      {
        error:
          'No se puede finalizar un préstamo con saldo pendiente en cuotas o penalizaciones. Registra el pago o aplica un ajuste administrativo primero.',
      },
      { status: 409 },
    );
  }

  if (targetStatus === 'archived' && loan.status !== 'draft' && pendingInstBalance + pendingPenBalance > 0) {
    return NextResponse.json(
      { error: 'Solo puedes archivar préstamos en borrador o completamente finalizados.' },
      { status: 409 },
    );
  }

  const updates: Record<string, unknown> = { status: targetStatus };
  if (targetStatus === 'archived') {
    updates.archived_at = new Date().toISOString();
  }

  if (loan.status === 'draft' && targetStatus === 'active') {
    const eq = computeEquivalentRates(
      Number(loan.interest_rate),
      loan.frequency as Frequency,
      Number(loan.installments_count),
    );
    const reg = settings.regulatory_policy;
    if (
      reg.configured &&
      reg.enforce_limit &&
      reg.max_ea_rate > 0 &&
      eq.eaEquivalent > reg.max_ea_rate
    ) {
      return NextResponse.json(
        {
          error: `La tasa equivalente (${eq.eaEquivalent}% EA) excede el tope regulatorio (${reg.max_ea_rate}% EA).`,
        },
        { status: 422 },
      );
    }
    updates.regulatory_snapshot = {
      configured: reg.configured,
      max_ea_rate: reg.max_ea_rate,
      max_monthly_rate: reg.max_monthly_rate,
      official_source: reg.official_source,
      effective_from: reg.effective_from,
      enforce_limit: reg.enforce_limit,
      loan_monthly_equivalent: eq.monthlyEquivalent,
      loan_ea_equivalent: eq.eaEquivalent,
      exceeds_configured_limit:
        reg.configured && reg.max_ea_rate > 0 ? eq.eaEquivalent > reg.max_ea_rate : false,
      captured_at: new Date().toISOString(),
    };
  }

  const { data: updated, error: updErr } = await adminClient
    .from('loans')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: `loan_status_${targetStatus}`,
    entity_type: 'loan',
    entity_id: id,
    old_data: { status: loan.status },
    new_data: { status: targetStatus },
    reason: payload.reason ?? null,
  });

  return NextResponse.json({ loan: updated });
}
