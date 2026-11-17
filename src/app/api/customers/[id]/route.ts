import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import {
  computeEffectiveInstallmentStatus,
  getLoanBillingMode,
  getLoanCurrentCapital,
  type LoanTermsSnapshot,
} from '@/lib/financial';
import { customerUpdateSchema, firstZodError } from '@/lib/validation';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const { adminClient } = auth.ctx;

  const [{ data: customer, error }, { data: loans }, { data: payments }] = await Promise.all([
    adminClient.from('customers').select('*').eq('id', id).maybeSingle(),
    adminClient
      .from('loans')
      .select('*')
      .eq('customer_id', id)
      .order('created_at', { ascending: false }),
    adminClient
      .from('payments')
      .select('*')
      .eq('customer_id', id)
      .order('received_at', { ascending: false }),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!customer) {
    return NextResponse.json({ error: 'Cliente no encontrado.' }, { status: 404 });
  }

  const loanIds = (loans ?? []).map((l) => l.id);
  const { data: installments } = loanIds.length
    ? await adminClient
        .from('loan_installments')
        .select('*')
        .in('loan_id', loanIds)
        .order('due_date', { ascending: true })
    : { data: [] };

  const installmentIds = (installments ?? []).map((i) => i.id);
  const { data: penalties } = installmentIds.length
    ? await adminClient.from('late_penalties').select('*').in('installment_id', installmentIds)
    : { data: [] };

  const today = todayBogota();
  const instByLoan = new Map<string, typeof installments>();
  for (const inst of installments ?? []) {
    const arr = instByLoan.get(inst.loan_id) ?? [];
    arr.push(inst);
    instByLoan.set(inst.loan_id, arr);
  }

  const penaltiesByInst = new Map<string, number>();
  for (const p of penalties ?? []) {
    const rem = Math.max(0, Number(p.amount) - Number(p.paid_amount));
    penaltiesByInst.set(p.installment_id, (penaltiesByInst.get(p.installment_id) ?? 0) + rem);
  }

  let totalCapitalBorrowed = 0;
  let totalPendingBalance = 0;
  let totalPenaltiesPending = 0;
  let paidInstallments = 0;
  let overdueInstallments = 0;
  let totalInstallments = 0;

  const enrichedLoans = (loans ?? []).map((loan) => {
    const loanInst = instByLoan.get(loan.id) ?? [];
    let paidAmount = 0;
    let remainingInstallments = 0;
    let remainingPenalties = 0;
    let overdueCount = 0;

    for (const inst of loanInst) {
      const orig = Number(inst.original_amount);
      const paid = Number(inst.paid_amount);
      paidAmount += paid;
      remainingInstallments += Math.max(0, orig - paid);
      remainingPenalties += penaltiesByInst.get(inst.id) ?? 0;

      if (loan.status !== 'draft' && loan.status !== 'archived') {
        totalInstallments += 1;
        const eff = computeEffectiveInstallmentStatus({
          original_amount: orig,
          paid_amount: paid,
          due_date: inst.due_date,
          today,
        });
        if (eff === 'paid') paidInstallments += 1;
        if (eff === 'overdue' || eff === 'overdue_partial') {
          overdueCount += 1;
          overdueInstallments += 1;
        }
      }
    }

    const billingMode = getLoanBillingMode(loan.terms_snapshot);
    const currentCapital = getLoanCurrentCapital(loan);
    const capitalPaid =
      billingMode === 'monthly_interest_only'
        ? Number((loan.terms_snapshot as LoanTermsSnapshot | null)?.capital_paid ?? 0)
        : 0;

    if (loan.status !== 'draft' && loan.status !== 'archived') {
      totalCapitalBorrowed += Number(loan.capital);
      totalPendingBalance += remainingInstallments + currentCapital;
      totalPenaltiesPending += remainingPenalties;
    }

    return {
      ...loan,
      billing_mode: billingMode,
      current_capital: currentCapital,
      paid_amount: paidAmount + capitalPaid,
      remaining_installments: remainingInstallments + currentCapital,
      remaining_penalties: remainingPenalties,
      overdue_count: overdueCount,
      installments_total: loanInst.length,
    };
  });

  const validPayments = (payments ?? []).filter((p) => !p.reversed_at);
  const totalPaidHistory = validPayments.reduce((sum, p) => sum + Number(p.received_amount), 0);

  return NextResponse.json({
    customer,
    loans: enrichedLoans,
    payments: payments ?? [],
    metrics: {
      totalCapitalBorrowed,
      totalPaidHistory,
      totalPendingBalance,
      totalPenaltiesPending,
      paidInstallments,
      overdueInstallments,
      totalInstallments,
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
  const parsed = customerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, profile, user } = auth.ctx;
  const { data: existing, error: findErr } = await adminClient
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (findErr || !existing) {
    return NextResponse.json({ error: 'Cliente no encontrado.' }, { status: 404 });
  }

  const { archived, ...fields } = parsed.data;
  const updates: Record<string, unknown> = {};

  if (typeof archived === 'boolean') {
    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Solo un administrador puede archivar o restaurar clientes.' },
        { status: 403 },
      );
    }
    if (archived) {
      const { data: activeLoans } = await adminClient
        .from('loans')
        .select('id, status')
        .eq('customer_id', id)
        .in('status', ['active', 'blocked', 'draft']);
      if ((activeLoans ?? []).length > 0) {
        return NextResponse.json(
          { error: 'No se puede archivar un cliente con préstamos activos, bloqueados o en borrador.' },
          { status: 409 },
        );
      }
      updates.archived_at = new Date().toISOString();
    } else {
      updates.archived_at = null;
    }
  }

  if (fields.document_type !== undefined) updates.document_type = fields.document_type;
  if (fields.document_number !== undefined) updates.document_number = fields.document_number;
  if (fields.first_names !== undefined) updates.first_names = fields.first_names;
  if (fields.last_names !== undefined) updates.last_names = fields.last_names;
  if (fields.phone !== undefined) updates.phone = fields.phone;
  if (fields.email !== undefined) updates.email = fields.email || null;
  if (fields.address !== undefined) updates.address = fields.address || null;
  if (fields.notes !== undefined) updates.notes = fields.notes || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No hay cambios para guardar.' }, { status: 400 });
  }

  const { data: updated, error: updErr } = await adminClient
    .from('customers')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (updErr) {
    if (updErr.code === '23505') {
      return NextResponse.json(
        { error: 'Ya existe otro cliente con ese número de documento.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: typeof archived === 'boolean' ? (archived ? 'customer_archived' : 'customer_restored') : 'customer_updated',
    entity_type: 'customer',
    entity_id: id,
    old_data: existing,
    new_data: updated,
  });

  return NextResponse.json({ customer: updated });
}
