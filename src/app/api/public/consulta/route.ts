import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  computePenaltyDetails,
  FREQUENCY_LABELS,
  getLoanBillingMode,
  getLoanCurrentCapital,
  type Frequency,
  type LoanTermsSnapshot,
} from '@/lib/financial';
import { loadAppSettings } from '@/lib/settings';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';

const lookupSchema = z.object({
  document_number: z
    .string()
    .trim()
    .min(5, 'Ingresa un número de documento válido (mínimo 5 caracteres)')
    .max(30, 'Número de documento demasiado largo')
    .regex(/^[0-9A-Za-z.\-]+$/, 'Solo se permiten números, letras o guiones'),
});

// Simple per-instance sliding window rate limiter to prevent automated enumeration
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateBuckets = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const prev = (rateBuckets.get(ip) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (prev.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, prev);
    return true;
  }
  prev.push(now);
  rateBuckets.set(ip, prev);
  if (rateBuckets.size > 1000) {
    for (const [k, list] of rateBuckets.entries()) {
      if (list.every((ts) => now - ts >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return false;
}

export async function GET() {
  try {
    const adminClient = createAdminSupabaseClient();
    const settings = await loadAppSettings(adminClient);
    return NextResponse.json({
      business: {
        company_name: settings.business_profile.company_name,
        city: settings.business_profile.city,
        phone: settings.business_profile.phone,
      },
    });
  } catch {
    return NextResponse.json({
      business: { company_name: 'Nexo Crédito', city: '', phone: '' },
    });
  }
}

export async function POST(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for') ?? 'unknown';
  const ip = forwarded.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Demasiadas consultas en poco tiempo. Espera un minuto e intenta nuevamente.' },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = lookupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Documento inválido.' },
      { status: 400 },
    );
  }

  const rawDoc = parsed.data.document_number.trim();
  const normalizedDigits = rawDoc.replace(/\./g, '');

  const adminClient = createAdminSupabaseClient();
  const settings = await loadAppSettings(adminClient);

  const candidates = rawDoc === normalizedDigits ? [rawDoc] : [rawDoc, normalizedDigits];
  const { data: customer } = await adminClient
    .from('customers')
    .select('id, document_type, first_names, last_names, archived_at')
    .in('document_number', candidates)
    .is('archived_at', null)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ found: false });
  }

  const [{ data: loans }, { data: payments }, { data: holidays }] = await Promise.all([
    adminClient
      .from('loans')
      .select(
        'id, capital, interest_rate, contractual_total, frequency, installments_count, disbursement_date, first_payment_date, status, terms_snapshot, created_at',
      )
      .eq('customer_id', customer.id)
      .in('status', ['active', 'blocked', 'finished'])
      .order('created_at', { ascending: false }),
    adminClient
      .from('payments')
      .select('id, received_amount, method, received_at')
      .eq('customer_id', customer.id)
      .is('reversed_at', null)
      .order('received_at', { ascending: false })
      .limit(20),
    adminClient.from('business_holidays').select('holiday_date'),
  ]);

  if (!loans || loans.length === 0) {
    return NextResponse.json({ found: false });
  }

  const loanIds = loans.map((l) => l.id);
  const { data: installments } = await adminClient
    .from('loan_installments')
    .select(
      'id, loan_id, installment_number, due_date, original_amount, paid_amount, penalty_frozen',
    )
    .in('loan_id', loanIds)
    .order('installment_number', { ascending: true });

  const instIds = (installments ?? []).map((i) => i.id);
  const { data: penalties } = instIds.length
    ? await adminClient
        .from('late_penalties')
        .select('id, installment_id, amount, paid_amount')
        .in('installment_id', instIds)
    : { data: [] };

  const today = todayBogota();
  const holidayDates = (holidays ?? []).map((h) => h.holiday_date as string);

  const penaltiesByInst = new Map<string, { total: number; paid: number }>();
  for (const p of penalties ?? []) {
    const entry = penaltiesByInst.get(p.installment_id) ?? { total: 0, paid: 0 };
    entry.total += Number(p.amount);
    entry.paid += Number(p.paid_amount);
    penaltiesByInst.set(p.installment_id, entry);
  }

  const instByLoan = new Map<string, typeof installments>();
  for (const inst of installments ?? []) {
    const arr = instByLoan.get(inst.loan_id) ?? [];
    arr.push(inst);
    instByLoan.set(inst.loan_id, arr);
  }

  let globalPendingBalance = 0;
  let globalPenaltiesPending = 0;
  let globalPaidTotal = 0;
  let globalOverdueCount = 0;
  let nextDueDate: string | null = null;
  let nextDueAmount = 0;

  const publicLoans = loans.map((loan) => {
    const loanInsts = instByLoan.get(loan.id) ?? [];
    let loanPaid = 0;
    let loanRemaining = 0;
    let loanRecordedPenaltiesRem = 0;
    let loanEstimatedPenaltiesRem = 0;
    let loanOverdueCount = 0;
    let loanPaidCount = 0;

    const publicInstallments = loanInsts.map((inst) => {
      const orig = Number(inst.original_amount);
      const paid = Number(inst.paid_amount);
      const remaining = Math.max(0, orig - paid);
      const penStats = penaltiesByInst.get(inst.id) ?? { total: 0, paid: 0 };
      const recRem = Math.max(0, penStats.total - penStats.paid);

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

      const estExtra = Math.max(0, calc.totalPenaltyAmount - penStats.total);
      const estPenRem = recRem + estExtra;

      loanPaid += paid;
      loanRemaining += remaining;
      loanRecordedPenaltiesRem += recRem;
      loanEstimatedPenaltiesRem += estPenRem;

      if (effStatus === 'paid') {
        loanPaidCount += 1;
      } else {
        if (effStatus === 'overdue' || effStatus === 'overdue_partial') {
          loanOverdueCount += 1;
        }
        if (
          loan.status !== 'finished' &&
          (!nextDueDate || inst.due_date < nextDueDate)
        ) {
          nextDueDate = inst.due_date;
          nextDueAmount = remaining + recRem;
        }
      }

      return {
        installment_number: inst.installment_number,
        due_date: inst.due_date,
        original_amount: orig,
        paid_amount: paid,
        remaining_amount: remaining,
        penalty_remaining: estPenRem,
        days_late: calc.daysLate,
        status: effStatus,
      };
    });

    const billingMode = getLoanBillingMode(loan.terms_snapshot);
    const currentCapital = getLoanCurrentCapital(loan);
    const capitalPaid =
      billingMode === 'monthly_interest_only'
        ? Number((loan.terms_snapshot as LoanTermsSnapshot | null)?.capital_paid ?? 0)
        : 0;

    if (loan.status !== 'finished') {
      globalPendingBalance += loanRemaining + currentCapital;
      globalPenaltiesPending += loanRecordedPenaltiesRem;
      globalOverdueCount += loanOverdueCount;
    }
    globalPaidTotal += loanPaid + capitalPaid;

    return {
      code: loan.id.slice(0, 8).toUpperCase(),
      billing_mode: billingMode,
      current_capital: currentCapital,
      interest_rate: Number(loan.interest_rate),
      frequency_label:
        billingMode === 'monthly_interest_only'
          ? 'Mensual (solo interés sobre capital)'
          : FREQUENCY_LABELS[loan.frequency as Frequency] ?? loan.frequency,
      installments_count: loan.installments_count,
      disbursement_date: loan.disbursement_date,
      status: loan.status,
      contractual_total: Number(loan.contractual_total),
      paid_total: loanPaid + capitalPaid,
      remaining_installments: loanRemaining,
      recorded_penalties_remaining: loanRecordedPenaltiesRem,
      estimated_penalties_remaining: loanEstimatedPenaltiesRem,
      paid_count: loanPaidCount,
      overdue_count: loanOverdueCount,
      installments: publicInstallments,
    };
  });

  // Mask last name slightly or display first names + initial for basic privacy
  const maskedLast = customer.last_names
    .split(/\s+/)
    .filter(Boolean)
    .map((part: string) => (part.length > 2 ? `${part.slice(0, 2)}***` : part))
    .join(' ');

  return NextResponse.json({
    found: true,
    today,
    customer_display: `${customer.first_names} ${maskedLast}`,
    document_type: customer.document_type,
    business: {
      company_name: settings.business_profile.company_name,
      city: settings.business_profile.city,
      phone: settings.business_profile.phone,
    },
    summary: {
      total_pending: globalPendingBalance + globalPenaltiesPending,
      pending_installments: globalPendingBalance,
      pending_penalties: globalPenaltiesPending,
      total_paid: globalPaidTotal,
      overdue_count: globalOverdueCount,
      next_due_date: nextDueDate,
      next_due_amount: nextDueAmount,
    },
    loans: publicLoans,
    recent_payments: (payments ?? []).map((p) => ({
      received_amount: Number(p.received_amount),
      method: p.method,
      received_at: p.received_at,
    })),
  });
}
