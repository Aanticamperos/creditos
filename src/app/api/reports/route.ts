import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { diffDaysISO, todayBogota } from '@/lib/dates';
import { computeEffectiveInstallmentStatus } from '@/lib/financial';

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { adminClient, profile } = auth.ctx;
  const fromDate = request.nextUrl.searchParams.get('from');
  const toDate = request.nextUrl.searchParams.get('to');

  const [
    { data: loans },
    { data: customers },
    { data: installments },
    { data: penalties },
    { data: payments },
    { data: profiles },
  ] = await Promise.all([
    adminClient.from('loans').select('*').order('created_at', { ascending: false }),
    adminClient
      .from('customers')
      .select('id, document_type, document_number, first_names, last_names, phone'),
    adminClient.from('loan_installments').select('*'),
    adminClient.from('late_penalties').select('*'),
    adminClient.from('payments').select('*').order('received_at', { ascending: false }),
    adminClient.from('profiles').select('id, full_name, role'),
  ]);

  const today = todayBogota();
  const bogotaFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const customerMap = new Map((customers ?? []).map((c) => [c.id, c]));
  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const loanMap = new Map((loans ?? []).map((l) => [l.id, l]));

  const inRange = (dateStr: string) => {
    if (fromDate && dateStr < fromDate) return false;
    if (toDate && dateStr > toDate) return false;
    return true;
  };

  let totalCapitalDisbursed = 0;
  let totalContractualInterest = 0;
  let totalContractualPortfolio = 0;
  let activeLoansCount = 0;
  let finishedLoansCount = 0;
  let blockedLoansCount = 0;

  for (const loan of loans ?? []) {
    if (loan.status === 'draft' || loan.status === 'archived') continue;
    if (!inRange(loan.disbursement_date)) continue;
    totalCapitalDisbursed += Number(loan.capital);
    totalContractualInterest += Number(loan.contractual_interest);
    totalContractualPortfolio += Number(loan.contractual_total);
    if (loan.status === 'active') activeLoansCount += 1;
    if (loan.status === 'finished') finishedLoansCount += 1;
    if (loan.status === 'blocked') blockedLoansCount += 1;
  }

  let totalCollected = 0;
  let collectedCash = 0;
  let collectedTransfer = 0;
  let reversedTotal = 0;

  const filteredPayments = [];
  for (const pay of payments ?? []) {
    const payDate = bogotaFormatter.format(new Date(pay.received_at));
    if (!inRange(payDate)) continue;
    const amt = Number(pay.received_amount);
    if (pay.reversed_at) {
      reversedTotal += amt;
    } else {
      totalCollected += amt;
      if (pay.method === 'cash') collectedCash += amt;
      else collectedTransfer += amt;
    }
    const cust = customerMap.get(pay.customer_id);
    filteredPayments.push({
      id: pay.id,
      date: payDate,
      received_at: pay.received_at,
      customer_name: cust ? `${cust.first_names} ${cust.last_names}` : 'Cliente',
      document: cust ? `${cust.document_type} ${cust.document_number}` : '',
      amount: amt,
      method: pay.method,
      reference: pay.transfer_reference,
      collector: profileMap.get(pay.received_by)?.full_name ?? '',
      reversed_at: pay.reversed_at,
    });
  }

  const agingBuckets = {
    al_dia: 0,
    d1_7: 0,
    d8_15: 0,
    d16_30: 0,
    d31_plus: 0,
  };

  let pendingInstallmentsBalance = 0;
  let overdueBalance = 0;
  const overdueInstallmentsList = [];

  for (const inst of installments ?? []) {
    const loan = loanMap.get(inst.loan_id);
    if (!loan || (loan.status !== 'active' && loan.status !== 'blocked')) continue;
    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    const rem = Math.max(0, orig - paid);
    if (rem <= 0) continue;

    pendingInstallmentsBalance += rem;
    const eff = computeEffectiveInstallmentStatus({
      original_amount: orig,
      paid_amount: paid,
      due_date: inst.due_date,
      today,
    });

    if (eff === 'overdue' || eff === 'overdue_partial') {
      overdueBalance += rem;
      const days = Math.max(1, diffDaysISO(inst.due_date, today));
      if (days <= 7) agingBuckets.d1_7 += rem;
      else if (days <= 15) agingBuckets.d8_15 += rem;
      else if (days <= 30) agingBuckets.d16_30 += rem;
      else agingBuckets.d31_plus += rem;

      const cust = customerMap.get(loan.customer_id);
      overdueInstallmentsList.push({
        installment_id: inst.id,
        loan_id: loan.id,
        customer_name: cust ? `${cust.first_names} ${cust.last_names}` : 'Cliente',
        phone: cust?.phone ?? '',
        installment_number: inst.installment_number,
        due_date: inst.due_date,
        days_overdue: days,
        remaining: rem,
      });
    } else {
      agingBuckets.al_dia += rem;
    }
  }

  overdueInstallmentsList.sort((a, b) => b.days_overdue - a.days_overdue);

  const pendingPenaltiesBalance = (penalties ?? []).reduce(
    (s, p) => s + Math.max(0, Number(p.amount) - Number(p.paid_amount)),
    0,
  );

  const delinquencyRate =
    pendingInstallmentsBalance > 0
      ? Number(((overdueBalance / pendingInstallmentsBalance) * 100).toFixed(1))
      : 0;

  let auditLogs: Record<string, unknown>[] = [];
  if (profile.role === 'admin') {
    const { data: logs } = await adminClient
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(120);
    auditLogs = (logs ?? []).map((l) => ({
      ...l,
      actor_name: l.actor_id ? profileMap.get(l.actor_id)?.full_name ?? 'Sistema' : 'Sistema',
    }));
  }

  const exportLoans = (loans ?? []).map((l) => {
    const cust = customerMap.get(l.customer_id);
    return {
      id: l.id,
      cliente: cust ? `${cust.first_names} ${cust.last_names}` : '',
      documento: cust ? `${cust.document_type} ${cust.document_number}` : '',
      capital: l.capital,
      interes_pct: l.interest_rate,
      interes_cop: l.contractual_interest,
      total_cop: l.contractual_total,
      frecuencia: l.frequency,
      cuotas: l.installments_count,
      desembolso: l.disbursement_date,
      primera_cuota: l.first_payment_date,
      estado: l.status,
    };
  });

  return NextResponse.json({
    summary: {
      totalCapitalDisbursed,
      totalContractualInterest,
      totalContractualPortfolio,
      totalCollected,
      collectedCash,
      collectedTransfer,
      reversedTotal,
      pendingInstallmentsBalance,
      pendingPenaltiesBalance,
      overdueBalance,
      delinquencyRate,
      activeLoansCount,
      finishedLoansCount,
      blockedLoansCount,
    },
    agingBuckets,
    overdueInstallments: overdueInstallmentsList,
    payments: filteredPayments,
    exportLoans,
    auditLogs,
    isAdmin: profile.role === 'admin',
  });
}
