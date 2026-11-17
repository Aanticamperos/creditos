export type Frequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';
export type BillingMode = 'fixed_installments' | 'monthly_interest_only';
export type LoanStatus = 'draft' | 'active' | 'finished' | 'archived' | 'blocked';
export type InstallmentStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'overdue_partial';

export interface LoanTermsSnapshot {
  billing_mode?: BillingMode;
  initial_capital?: number;
  current_capital?: number;
  capital_paid?: number;
  capital_added?: number;
  billing_day?: number;
  next_cycle_date?: string;
  [key: string]: unknown;
}

export function getLoanBillingMode(termsSnapshot: unknown): BillingMode {
  if (
    termsSnapshot &&
    typeof termsSnapshot === 'object' &&
    (termsSnapshot as LoanTermsSnapshot).billing_mode === 'monthly_interest_only'
  ) {
    return 'monthly_interest_only';
  }
  return 'fixed_installments';
}

export function getLoanCurrentCapital(loan: {
  capital: number;
  status: string;
  terms_snapshot?: unknown;
}): number {
  if (getLoanBillingMode(loan.terms_snapshot) !== 'monthly_interest_only') return 0;
  if (loan.status === 'draft' || loan.status === 'archived' || loan.status === 'finished') {
    return 0;
  }
  const snap = loan.terms_snapshot as LoanTermsSnapshot | undefined;
  if (typeof snap?.current_capital === 'number') {
    return Math.max(0, Math.round(snap.current_capital));
  }
  return Number(loan.capital);
}

/** Shifts a date forward if it falls on Sunday or a business holiday. */
export function shiftToWorkingDay(isoDate: string, holidays: string[] = []): string {
  const h = new Set(holidays);
  let d = new Date(`${isoDate}T12:00:00Z`);
  while (d.getUTCDay() === 0 || h.has(d.toISOString().slice(0, 10))) {
    d = new Date(d.getTime() + 86_400_000);
  }
  return d.toISOString().slice(0, 10);
}

export interface PenaltyPolicy {
  enabled: boolean;
  days_per_period: number;
  penalty_mode: 'installment_value' | 'fixed_percent';
  percent_of_installment: number;
  freeze_on_partial: boolean;
  apply_to_frequencies: Frequency[];
}

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Diaria',
  weekly: 'Semanal',
  biweekly: 'Quincenal',
  monthly: 'Mensual (30 días)',
};

export function quote(capital: number, rate: number, installments: number) {
  if (
    !Number.isInteger(capital) ||
    capital <= 0 ||
    rate < 0 ||
    !Number.isInteger(installments) ||
    installments < 1
  ) {
    throw new Error('Condiciones financieras inválidas');
  }
  const interest = Math.round((capital * rate) / 100);
  const total = capital + interest;
  const base = Math.floor(total / installments);
  return {
    interest,
    total,
    values: Array.from({ length: installments }, (_, i) =>
      i === installments - 1 ? total - base * (installments - 1) : base,
    ),
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};
const isWorking = (d: Date, holidays: Set<string>) => d.getUTCDay() !== 0 && !holidays.has(iso(d));
const effective = (d: Date, holidays: Set<string>) => {
  let x = d;
  while (!isWorking(x, holidays)) x = plusDays(x, 1);
  return x;
};

export function schedule(
  firstDate: string,
  frequency: Frequency,
  count: number,
  holidays: string[] = [],
) {
  const h = new Set(holidays);
  const first = new Date(`${firstDate}T12:00:00Z`);
  const dates: { scheduled: string; due: string }[] = [];
  if (frequency === 'daily') {
    let current = first;
    while (dates.length < count) {
      if (isWorking(current, h)) {
        dates.push({ scheduled: iso(current), due: iso(current) });
      }
      current = plusDays(current, 1);
    }
  } else {
    const interval = frequency === 'weekly' ? 7 : frequency === 'biweekly' ? 15 : 30;
    for (let i = 0; i < count; i++) {
      const scheduled = plusDays(first, i * interval);
      dates.push({ scheduled: iso(scheduled), due: iso(effective(scheduled, h)) });
    }
  }
  return dates;
}

export function lateWorkingDays(due: string, today: string, holidays: string[] = []) {
  if (today <= due) return 0;
  let day = plusDays(new Date(`${due}T12:00:00Z`), 1);
  let count = 0;
  const now = new Date(`${today}T12:00:00Z`);
  const h = new Set(holidays);
  while (day <= now) {
    if (isWorking(day, h)) count++;
    day = plusDays(day, 1);
  }
  return count;
}

export function dailyPenalty(
  value: number,
  due: string,
  today: string,
  holidays: string[],
  hasPartial: boolean,
  daysPerPeriod = 4,
) {
  if (hasPartial || daysPerPeriod < 1) return 0;
  return Math.floor(lateWorkingDays(due, today, holidays) / daysPerPeriod) * value;
}

export function computePenaltyDetails(params: {
  originalAmount: number;
  paidAmount: number;
  dueDate: string;
  today: string;
  holidays: string[];
  penaltyFrozen: boolean;
  frequency: Frequency;
  policy: PenaltyPolicy;
}) {
  const {
    originalAmount,
    paidAmount,
    dueDate,
    today,
    holidays,
    penaltyFrozen,
    frequency,
    policy,
  } = params;

  const daysLate = lateWorkingDays(dueDate, today, holidays);
  const isPaid = paidAmount >= originalAmount;
  const hasPartial = paidAmount > 0;
  const appliesToFrequency = policy.apply_to_frequencies.includes(frequency);

  if (
    !policy.enabled ||
    !appliesToFrequency ||
    isPaid ||
    penaltyFrozen ||
    (policy.freeze_on_partial && hasPartial) ||
    daysLate < policy.days_per_period
  ) {
    return { daysLate, periods: 0, periodAmount: 0, totalPenaltyAmount: 0 };
  }

  const periods = Math.floor(daysLate / policy.days_per_period);
  const periodAmount =
    policy.penalty_mode === 'installment_value'
      ? originalAmount
      : Math.max(1, Math.round((originalAmount * policy.percent_of_installment) / 100));

  return {
    daysLate,
    periods,
    periodAmount,
    totalPenaltyAmount: periods * periodAmount,
  };
}

export function computeEffectiveInstallmentStatus(params: {
  original_amount: number;
  paid_amount: number;
  due_date: string;
  today: string;
}): InstallmentStatus {
  const { original_amount, paid_amount, due_date, today } = params;
  if (paid_amount >= original_amount) return 'paid';
  const isPastDue = today > due_date;
  if (isPastDue) {
    return paid_amount > 0 ? 'overdue_partial' : 'overdue';
  }
  return paid_amount > 0 ? 'partial' : 'pending';
}

/** Estimates nominal monthly & effective annual rates for regulatory comparison. */
export function computeEquivalentRates(
  ratePercent: number,
  frequency: Frequency,
  installmentsCount: number,
) {
  const daysBetween =
    frequency === 'daily' ? 1.17 : frequency === 'weekly' ? 7 : frequency === 'biweekly' ? 15 : 30;
  const totalDays = Math.max(1, Math.round(installmentsCount * daysBetween));
  const months = totalDays / 30;
  const monthlyRate = months > 0 ? ratePercent / months : ratePercent;
  const eaRate = (Math.pow(1 + monthlyRate / 100, 12) - 1) * 100;
  return {
    estimatedDays: totalDays,
    monthlyEquivalent: Number(monthlyRate.toFixed(2)),
    eaEquivalent: Number(Math.min(eaRate, 9999).toFixed(2)),
  };
}

export interface AllocatableInstallment {
  id: string;
  due_date: string;
  installment_number: number;
  remaining: number;
}

export interface AllocatablePenalty {
  id: string;
  installment_id: string;
  period_number: number;
  remaining: number;
}

export function autoAllocateWaterfall(
  totalAmount: number,
  installments: AllocatableInstallment[],
  penalties: AllocatablePenalty[] = [],
) {
  let left = Math.max(0, Math.round(totalAmount));
  const penaltyMap: Record<string, number> = {};
  const installmentMap: Record<string, number> = {};

  const sortedPenalties = [...penalties].sort((a, b) => a.period_number - b.period_number);
  for (const pen of sortedPenalties) {
    if (left <= 0) break;
    if (pen.remaining <= 0) continue;
    const take = Math.min(left, pen.remaining);
    penaltyMap[pen.id] = take;
    left -= take;
  }

  const sortedInstallments = [...installments].sort((a, b) => {
    const dateCmp = a.due_date.localeCompare(b.due_date);
    return dateCmp !== 0 ? dateCmp : a.installment_number - b.installment_number;
  });

  for (const inst of sortedInstallments) {
    if (left <= 0) break;
    if (inst.remaining <= 0) continue;
    const take = Math.min(left, inst.remaining);
    installmentMap[inst.id] = take;
    left -= take;
  }

  return {
    penaltyMap,
    installmentMap,
    allocated: Math.round(totalAmount) - left,
    unallocated: left,
  };
}

/** Builds a Colombian WhatsApp deep link from a customer phone number. */
export function buildWhatsAppUrl(phone: string | null | undefined, message: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  const normalized = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
