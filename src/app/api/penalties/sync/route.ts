import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import { computePenaltyDetails, type Frequency } from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';

export async function POST() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { adminClient, user } = auth.ctx;
  const today = todayBogota();

  const [{ data: loans }, { data: holidays }, settings] = await Promise.all([
    adminClient.from('loans').select('id, frequency, status').in('status', ['active', 'blocked']),
    adminClient.from('business_holidays').select('holiday_date'),
    loadAppSettings(adminClient),
  ]);

  const loanList = loans ?? [];
  if (loanList.length === 0) {
    return NextResponse.json({ updatedInstallments: 0, createdPenalties: 0 });
  }

  const loanFreqMap = new Map(loanList.map((l) => [l.id, l.frequency as Frequency]));
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);

  const { data: installments, error: instErr } = await adminClient
    .from('loan_installments')
    .select('*')
    .in(
      'loan_id',
      loanList.map((l) => l.id),
    )
    .lt('due_date', today);

  if (instErr) {
    return NextResponse.json({ error: instErr.message }, { status: 500 });
  }

  let updatedInstallments = 0;
  const penaltiesToUpsert: {
    installment_id: string;
    period_number: number;
    amount: number;
    days_counted: number;
  }[] = [];

  for (const inst of installments ?? []) {
    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    if (paid >= orig) continue;

    const targetStatus = paid > 0 ? 'overdue_partial' : 'overdue';
    if (inst.status !== targetStatus) {
      const { error: uErr } = await adminClient
        .from('loan_installments')
        .update({ status: targetStatus })
        .eq('id', inst.id);
      if (!uErr) updatedInstallments += 1;
    }

    const freq = loanFreqMap.get(inst.loan_id) ?? 'daily';
    const calc = computePenaltyDetails({
      originalAmount: orig,
      paidAmount: paid,
      dueDate: inst.due_date,
      today,
      holidays: holidayDates,
      penaltyFrozen: Boolean(inst.penalty_frozen),
      frequency: freq,
      policy: settings.penalty_policy,
    });

    if (calc.periods > 0 && calc.periodAmount > 0) {
      for (let p = 1; p <= calc.periods; p++) {
        penaltiesToUpsert.push({
          installment_id: inst.id,
          period_number: p,
          amount: calc.periodAmount,
          days_counted: p * settings.penalty_policy.days_per_period,
        });
      }
    }
  }

  let createdPenalties = 0;
  if (penaltiesToUpsert.length > 0) {
    const { data: existingPens } = await adminClient
      .from('late_penalties')
      .select('installment_id, period_number')
      .in(
        'installment_id',
        Array.from(new Set(penaltiesToUpsert.map((p) => p.installment_id))),
      );

    const existingKeys = new Set(
      (existingPens ?? []).map((p) => `${p.installment_id}:${p.period_number}`),
    );
    const freshPenalties = penaltiesToUpsert.filter(
      (p) => !existingKeys.has(`${p.installment_id}:${p.period_number}`),
    );

    if (freshPenalties.length > 0) {
      const { error: penErr } = await adminClient
        .from('late_penalties')
        .upsert(freshPenalties, { onConflict: 'installment_id,period_number', ignoreDuplicates: true });
      if (penErr) {
        return NextResponse.json({ error: penErr.message }, { status: 500 });
      }
      createdPenalties = freshPenalties.length;
    }
  }

  if (updatedInstallments > 0 || createdPenalties > 0) {
    await writeAuditLog(adminClient, {
      actor_id: user.id,
      action: 'penalties_and_overdue_synced',
      entity_type: 'loan_installment',
      new_data: { updatedInstallments, createdPenalties, sync_date: today },
    });
  }

  return NextResponse.json({ updatedInstallments, createdPenalties, today });
}
