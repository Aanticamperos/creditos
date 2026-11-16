import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  computePenaltyDetails,
  type Frequency,
} from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const bucket = request.nextUrl.searchParams.get('bucket') ?? 'all';
  const customerId = request.nextUrl.searchParams.get('customerId');
  const onlyUnpaid = request.nextUrl.searchParams.get('onlyUnpaid') === 'true';

  const { adminClient } = auth.ctx;

  let loansQuery = adminClient
    .from('loans')
    .select('id, customer_id, frequency, capital, contractual_total, status, installments_count')
    .in('status', ['active', 'blocked']);

  if (customerId) {
    loansQuery = loansQuery.eq('customer_id', customerId);
  }

  const [{ data: loans, error: loanErr }, { data: customers }, { data: holidays }, settings] =
    await Promise.all([
      loansQuery,
      adminClient
        .from('customers')
        .select('id, document_type, document_number, first_names, last_names, phone'),
      adminClient.from('business_holidays').select('holiday_date'),
      loadAppSettings(adminClient),
    ]);

  if (loanErr) {
    return NextResponse.json({ error: loanErr.message }, { status: 500 });
  }

  const loanIds = (loans ?? []).map((l) => l.id);
  if (loanIds.length === 0) {
    return NextResponse.json({ installments: [], penalties: [], today: todayBogota() });
  }

  const { data: installments, error: instErr } = await adminClient
    .from('loan_installments')
    .select('*')
    .in('loan_id', loanIds)
    .order('due_date', { ascending: true })
    .order('installment_number', { ascending: true });

  if (instErr) {
    return NextResponse.json({ error: instErr.message }, { status: 500 });
  }

  const instIds = (installments ?? []).map((i) => i.id);
  const { data: penalties } = instIds.length
    ? await adminClient
        .from('late_penalties')
        .select('*')
        .in('installment_id', instIds)
        .order('period_number', { ascending: true })
    : { data: [] };

  const loanMap = new Map((loans ?? []).map((l) => [l.id, l]));
  const customerMap = new Map((customers ?? []).map((c) => [c.id, c]));
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);
  const today = todayBogota();

  const penaltiesByInst = new Map<string, typeof penalties>();
  for (const p of penalties ?? []) {
    const arr = penaltiesByInst.get(p.installment_id) ?? [];
    arr.push(p);
    penaltiesByInst.set(p.installment_id, arr);
  }

  const enriched = (installments ?? [])
    .map((inst) => {
      const loan = loanMap.get(inst.loan_id);
      if (!loan) return null;
      const customer = customerMap.get(loan.customer_id) ?? null;
      const orig = Number(inst.original_amount);
      const paid = Number(inst.paid_amount);
      const remaining = Math.max(0, orig - paid);
      const effStatus = computeEffectiveInstallmentStatus({
        original_amount: orig,
        paid_amount: paid,
        due_date: inst.due_date,
        today,
      });

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

      const unrecordedExtra = Math.max(0, calc.totalPenaltyAmount - recordedTotal);

      return {
        ...inst,
        effective_status: effStatus,
        remaining_amount: remaining,
        days_late: calc.daysLate,
        recorded_penalties_remaining: recordedRemaining,
        estimated_penalties_remaining: recordedRemaining + unrecordedExtra,
        unrecorded_penalties: unrecordedExtra,
        penalties: instPenalties,
        loan: {
          id: loan.id,
          frequency: loan.frequency,
          installments_count: loan.installments_count,
          status: loan.status,
        },
        customer,
      };
    })
    .filter((item): item is NonNullable<typeof item> => {
      if (!item) return false;
      if (onlyUnpaid && item.remaining_amount <= 0 && item.recorded_penalties_remaining <= 0) {
        return false;
      }
      if (bucket === 'today') {
        return item.due_date === today && item.effective_status !== 'paid';
      }
      if (bucket === 'overdue') {
        return item.effective_status === 'overdue' || item.effective_status === 'overdue_partial';
      }
      if (bucket === 'partial') {
        return item.effective_status === 'partial' || item.effective_status === 'overdue_partial';
      }
      if (bucket === 'upcoming') {
        return item.due_date > today && item.effective_status !== 'paid';
      }
      if (bucket === 'paid') {
        return item.effective_status === 'paid';
      }
      return true;
    });

  const openPenalties = (penalties ?? [])
    .filter((p) => Number(p.amount) > Number(p.paid_amount))
    .map((p) => {
      const parentInst = (installments ?? []).find((i) => i.id === p.installment_id);
      const loan = parentInst ? loanMap.get(parentInst.loan_id) : null;
      return {
        ...p,
        remaining: Number(p.amount) - Number(p.paid_amount),
        installment_number: parentInst?.installment_number ?? 0,
        due_date: parentInst?.due_date ?? '',
        loan_id: loan?.id ?? null,
      };
    });

  return NextResponse.json({
    installments: enriched,
    penalties: openPenalties,
    today,
  });
}
