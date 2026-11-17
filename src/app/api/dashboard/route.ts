import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { addDaysISO, todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  computePenaltyDetails,
  getLoanCurrentCapital,
  type Frequency,
} from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';

export async function GET() {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { adminClient } = auth.ctx;
  const today = todayBogota();
  const startChartDate = addDaysISO(today, -13);

  const [
    { data: customers },
    { data: loans },
    { data: installments },
    { data: penalties },
    { data: payments },
    { data: holidays },
    settings,
  ] = await Promise.all([
    adminClient.from('customers').select('id, first_names, last_names, phone, archived_at'),
    adminClient
      .from('loans')
      .select(
        'id, customer_id, capital, contractual_total, frequency, status, disbursement_date, terms_snapshot',
      ),
    adminClient
      .from('loan_installments')
      .select('id, loan_id, installment_number, due_date, original_amount, paid_amount, penalty_frozen'),
    adminClient.from('late_penalties').select('id, installment_id, amount, paid_amount'),
    adminClient
      .from('payments')
      .select('id, customer_id, received_amount, method, received_at, reversed_at')
      .is('reversed_at', null)
      .order('received_at', { ascending: false }),
    adminClient.from('business_holidays').select('holiday_date'),
    loadAppSettings(adminClient),
  ]);

  const customerMap = new Map((customers ?? []).map((c) => [c.id, c]));
  const loanMap = new Map((loans ?? []).map((l) => [l.id, l]));
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);

  const activeCustomersCount = (customers ?? []).filter((c) => !c.archived_at).length;
  const activeLoans = (loans ?? []).filter((l) => l.status === 'active' || l.status === 'blocked');
  const activeCapital = activeLoans.reduce((s, l) => s + Number(l.capital), 0);
  const activeRevolvingCapital = activeLoans.reduce((s, l) => s + getLoanCurrentCapital(l), 0);

  const penaltiesByInst = new Map<string, { total: number; paid: number }>();
  let pendingPenaltiesTotal = 0;
  for (const p of penalties ?? []) {
    const entry = penaltiesByInst.get(p.installment_id) ?? { total: 0, paid: 0 };
    entry.total += Number(p.amount);
    entry.paid += Number(p.paid_amount);
    penaltiesByInst.set(p.installment_id, entry);
  }

  let pendingInstallmentsBalance = 0;
  let estimatedPendingPenalties = 0;
  let overdueInstallmentsCount = 0;
  let overdueAmount = 0;
  let dueTodayCount = 0;
  let dueTodayAmount = 0;
  let partialCount = 0;

  const todayQueue: {
    installment_id: string;
    loan_id: string;
    customer_id: string;
    customer_name: string;
    phone: string;
    installment_number: number;
    due_date: string;
    remaining: number;
    effective_status: string;
  }[] = [];

  for (const inst of installments ?? []) {
    const loan = loanMap.get(inst.loan_id);
    if (!loan || (loan.status !== 'active' && loan.status !== 'blocked')) continue;

    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    const remaining = Math.max(0, orig - paid);
    const penStats = penaltiesByInst.get(inst.id) ?? { total: 0, paid: 0 };
    const recordedRem = Math.max(0, penStats.total - penStats.paid);
    pendingPenaltiesTotal += recordedRem;

    const eff = computeEffectiveInstallmentStatus({
      original_amount: orig,
      paid_amount: paid,
      due_date: inst.due_date,
      today,
    });

    pendingInstallmentsBalance += remaining;

    if (eff === 'partial' || eff === 'overdue_partial') partialCount += 1;

    if (eff !== 'paid') {
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
      const extra = Math.max(0, calc.totalPenaltyAmount - penStats.total);
      estimatedPendingPenalties += recordedRem + extra;
    }

    const cust = customerMap.get(loan.customer_id);
    const custName = cust ? `${cust.first_names} ${cust.last_names}` : 'Cliente';

    if (eff === 'overdue' || eff === 'overdue_partial') {
      overdueInstallmentsCount += 1;
      overdueAmount += remaining;
    }

    if (inst.due_date === today && eff !== 'paid') {
      dueTodayCount += 1;
      dueTodayAmount += remaining;
    }

    if ((inst.due_date <= today && eff !== 'paid') && todayQueue.length < 12) {
      todayQueue.push({
        installment_id: inst.id,
        loan_id: loan.id,
        customer_id: loan.customer_id,
        customer_name: custName,
        phone: cust?.phone ?? '',
        installment_number: inst.installment_number,
        due_date: inst.due_date,
        remaining,
        effective_status: eff,
      });
    }
  }

  // Payments aggregation (Colombia timezone date extraction)
  const bogotaFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const dailyBuckets = new Map<string, { date: string; cash: number; transfer: number; total: number }>();
  for (let i = 0; i < 14; i++) {
    const d = addDaysISO(startChartDate, i);
    dailyBuckets.set(d, { date: d, cash: 0, transfer: 0, total: 0 });
  }

  let collectedToday = 0;
  let collectedTodayCash = 0;
  let collectedTodayTransfer = 0;
  let collectedMonth = 0;
  const currentMonthPrefix = today.slice(0, 7);

  for (const pay of payments ?? []) {
    const amt = Number(pay.received_amount);
    const payDate = bogotaFormatter.format(new Date(pay.received_at));

    if (payDate === today) {
      collectedToday += amt;
      if (pay.method === 'cash') collectedTodayCash += amt;
      else collectedTodayTransfer += amt;
    }
    if (payDate.startsWith(currentMonthPrefix)) {
      collectedMonth += amt;
    }
    const bucket = dailyBuckets.get(payDate);
    if (bucket) {
      bucket.total += amt;
      if (pay.method === 'cash') bucket.cash += amt;
      else bucket.transfer += amt;
    }
  }

  const recentPayments = (payments ?? []).slice(0, 6).map((p) => {
    const cust = customerMap.get(p.customer_id);
    return {
      id: p.id,
      customer_id: p.customer_id,
      customer_name: cust ? `${cust.first_names} ${cust.last_names}` : 'Cliente',
      received_amount: p.received_amount,
      method: p.method,
      received_at: p.received_at,
    };
  });

  todayQueue.sort((a, b) => a.due_date.localeCompare(b.due_date));

  return NextResponse.json({
    today,
    kpis: {
      activeCustomersCount,
      activeLoansCount: activeLoans.length,
      activeCapital,
      pendingPortfolio: pendingInstallmentsBalance + activeRevolvingCapital + pendingPenaltiesTotal,
      pendingInstallmentsBalance: pendingInstallmentsBalance + activeRevolvingCapital,
      pendingPenaltiesTotal,
      estimatedPendingPenalties,
      collectedToday,
      collectedTodayCash,
      collectedTodayTransfer,
      collectedMonth,
      overdueInstallmentsCount,
      overdueAmount,
      dueTodayCount,
      dueTodayAmount,
      partialCount,
    },
    chart14d: Array.from(dailyBuckets.values()),
    todayQueue,
    recentPayments,
    regulatoryConfigured: settings.regulatory_policy.configured,
    holidaysCount: holidayDates.length,
  });
}
