import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { todayBogota } from '@/lib/dates';
import type { LoanTermsSnapshot } from '@/lib/financial';
import { firstZodError, paymentReverseSchema } from '@/lib/validation';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = paymentReverseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const { data: payment, error: payErr } = await adminClient
    .from('payments')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (payErr || !payment) {
    return NextResponse.json({ error: 'Pago no encontrado.' }, { status: 404 });
  }
  if (payment.reversed_at) {
    return NextResponse.json({ error: 'Este pago ya fue reversado anteriormente.' }, { status: 409 });
  }

  const [{ data: allocations }, { data: capAdjustments }] = await Promise.all([
    adminClient.from('payment_allocations').select('*').eq('payment_id', id),
    adminClient
      .from('financial_adjustments')
      .select('*')
      .eq('adjustment_type', 'capital_payment')
      .contains('original_data', { payment_id: id }),
  ]);

  const nowIso = new Date().toISOString();
  const { error: revErr } = await adminClient
    .from('payments')
    .update({ reversed_at: nowIso })
    .eq('id', id);

  if (revErr) {
    return NextResponse.json({ error: revErr.message }, { status: 500 });
  }

  const today = todayBogota();
  const touchedLoans = new Set<string>();

  for (const alloc of allocations ?? []) {
    if (alloc.installment_id) {
      const { data: inst } = await adminClient
        .from('loan_installments')
        .select('*')
        .eq('id', alloc.installment_id)
        .maybeSingle();
      if (inst) {
        touchedLoans.add(inst.loan_id);
        const newPaid = Math.max(0, Number(inst.paid_amount) - Number(alloc.amount));
        const isPastDue = today > inst.due_date;
        const newStatus =
          newPaid === 0
            ? isPastDue
              ? 'overdue'
              : 'pending'
            : isPastDue
              ? 'overdue_partial'
              : 'partial';
        await adminClient
          .from('loan_installments')
          .update({
            paid_amount: newPaid,
            status: newStatus,
            penalty_frozen: newPaid > 0 ? inst.penalty_frozen : false,
          })
          .eq('id', inst.id);
      }
    }
    if (alloc.penalty_id) {
      const { data: pen } = await adminClient
        .from('late_penalties')
        .select('*')
        .eq('id', alloc.penalty_id)
        .maybeSingle();
      if (pen) {
        const newPaid = Math.max(0, Number(pen.paid_amount) - Number(alloc.amount));
        await adminClient
          .from('late_penalties')
          .update({ paid_amount: newPaid })
          .eq('id', pen.id);
        const { data: pInst } = await adminClient
          .from('loan_installments')
          .select('loan_id')
          .eq('id', pen.installment_id)
          .maybeSingle();
        if (pInst) touchedLoans.add(pInst.loan_id);
      }
    }
  }

  for (const adj of capAdjustments ?? []) {
    touchedLoans.add(adj.loan_id);
    const { data: loan } = await adminClient
      .from('loans')
      .select('id, capital, terms_snapshot')
      .eq('id', adj.loan_id)
      .maybeSingle();
    if (loan) {
      const snap = (loan.terms_snapshot ?? {}) as LoanTermsSnapshot;
      const restoredCapital = Number(snap.current_capital ?? 0) + Number(adj.amount);
      const restoredPaid = Math.max(0, Number(snap.capital_paid ?? 0) - Number(adj.amount));
      await adminClient
        .from('loans')
        .update({
          terms_snapshot: {
            ...snap,
            current_capital: restoredCapital,
            capital_paid: restoredPaid,
          },
        })
        .eq('id', loan.id);
    }
  }

  for (const loanId of touchedLoans) {
    await adminClient
      .from('loans')
      .update({ status: 'active' })
      .eq('id', loanId)
      .eq('status', 'finished');
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: 'payment_reversed',
    entity_type: 'payment',
    entity_id: id,
    old_data: { received_amount: payment.received_amount, customer_id: payment.customer_id },
    new_data: { reversed_at: nowIso, touched_loans: Array.from(touchedLoans) },
    reason: parsed.data.reason,
  });

  return NextResponse.json({ reversed: true, reversed_at: nowIso });
}
