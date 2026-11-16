import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { writeAuditLog } from '@/lib/audit';
import { adjustmentCreateSchema, firstZodError } from '@/lib/validation';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = adjustmentCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstZodError(parsed.error) }, { status: 400 });
  }

  const { adminClient, user } = auth.ctx;
  const input = parsed.data;

  const { data: loan, error: loanErr } = await adminClient
    .from('loans')
    .select('*')
    .eq('id', input.loan_id)
    .maybeSingle();

  if (loanErr || !loan) {
    return NextResponse.json({ error: 'Préstamo no encontrado.' }, { status: 404 });
  }

  let originalData: Record<string, unknown> = {};

  if (input.adjustment_type === 'penalty_waiver') {
    if (!input.penalty_id) {
      return NextResponse.json(
        { error: 'Selecciona la penalización que deseas condonar.' },
        { status: 400 },
      );
    }
    const { data: pen } = await adminClient
      .from('late_penalties')
      .select('*')
      .eq('id', input.penalty_id)
      .maybeSingle();

    if (!pen) {
      return NextResponse.json({ error: 'Penalización no encontrada.' }, { status: 404 });
    }
    const remaining = Math.max(0, Number(pen.amount) - Number(pen.paid_amount));
    if (remaining <= 0) {
      return NextResponse.json({ error: 'Esta penalización ya está saldada.' }, { status: 400 });
    }

    const waiveAmt = input.amount > 0 ? Math.min(input.amount, remaining) : remaining;
    const newAmount = Math.max(1, Number(pen.amount) - waiveAmt);
    originalData = { penalty_id: pen.id, old_amount: pen.amount, paid_amount: pen.paid_amount };

    if (Number(pen.paid_amount) > 0 && waiveAmt === remaining) {
      await adminClient
        .from('late_penalties')
        .update({ amount: Number(pen.paid_amount) })
        .eq('id', pen.id);
    } else if (waiveAmt === remaining && Number(pen.paid_amount) === 0) {
      // Schema enforces amount > 0 on late_penalties, so mark paid_amount = amount to waive remaining without deleting history
      await adminClient
        .from('late_penalties')
        .update({ paid_amount: Number(pen.amount) })
        .eq('id', pen.id);
    } else {
      await adminClient
        .from('late_penalties')
        .update({ amount: Math.max(Number(pen.paid_amount) || 1, newAmount) })
        .eq('id', pen.id);
    }
  } else if (input.adjustment_type === 'installment_discount') {
    if (!input.installment_id) {
      return NextResponse.json(
        { error: 'Selecciona la cuota sobre la cual aplicar el descuento.' },
        { status: 400 },
      );
    }
    const { data: inst } = await adminClient
      .from('loan_installments')
      .select('*')
      .eq('id', input.installment_id)
      .eq('loan_id', input.loan_id)
      .maybeSingle();

    if (!inst) {
      return NextResponse.json({ error: 'Cuota no encontrada en este préstamo.' }, { status: 404 });
    }
    const orig = Number(inst.original_amount);
    const paid = Number(inst.paid_amount);
    const remaining = Math.max(0, orig - paid);
    if (remaining <= 0) {
      return NextResponse.json({ error: 'La cuota ya está pagada.' }, { status: 400 });
    }

    const maxDiscount = paid > 0 ? remaining : Math.max(0, remaining - 1);
    if (input.amount <= 0 || input.amount > maxDiscount) {
      return NextResponse.json(
        {
          error:
            paid > 0
              ? `El descuento debe estar entre 1 y ${maxDiscount} COP.`
              : `El descuento en cuota sin abonos previos puede ser hasta ${maxDiscount} COP (el valor mínimo de cuota es $1 COP).`,
        },
        { status: 400 },
      );
    }

    const newOriginal = orig - input.amount;
    originalData = {
      installment_id: inst.id,
      installment_number: inst.installment_number,
      old_original_amount: orig,
      paid_amount: paid,
    };

    const newStatus = paid >= newOriginal ? 'paid' : inst.status;
    await adminClient
      .from('loan_installments')
      .update({ original_amount: newOriginal, status: newStatus })
      .eq('id', inst.id);
  }

  const { data: adjustment, error: adjErr } = await adminClient
    .from('financial_adjustments')
    .insert({
      loan_id: input.loan_id,
      adjustment_type: input.adjustment_type,
      amount: input.amount,
      reason: input.reason,
      original_data: originalData,
      created_by: user.id,
    })
    .select('*')
    .single();

  if (adjErr) {
    return NextResponse.json({ error: adjErr.message }, { status: 500 });
  }

  await writeAuditLog(adminClient, {
    actor_id: user.id,
    action: `adjustment_${input.adjustment_type}`,
    entity_type: 'loan',
    entity_id: input.loan_id,
    old_data: originalData,
    new_data: { adjustment_id: adjustment.id, amount: input.amount },
    reason: input.reason,
  });

  // Check if loan should auto-finish after discount/waiver
  const { data: loanInsts } = await adminClient
    .from('loan_installments')
    .select('id, original_amount, paid_amount')
    .eq('loan_id', input.loan_id);

  const instPending = (loanInsts ?? []).some(
    (i) => Number(i.paid_amount) < Number(i.original_amount),
  );
  if (!instPending) {
    const lInstIds = (loanInsts ?? []).map((i) => i.id);
    const { data: loanPens } = lInstIds.length
      ? await adminClient
          .from('late_penalties')
          .select('amount, paid_amount')
          .in('installment_id', lInstIds)
      : { data: [] };
    const penPending = (loanPens ?? []).some((p) => Number(p.paid_amount) < Number(p.amount));
    if (!penPending) {
      await adminClient
        .from('loans')
        .update({ status: 'finished' })
        .eq('id', input.loan_id)
        .in('status', ['active', 'blocked']);
    }
  }

  return NextResponse.json({ adjustment }, { status: 201 });
}
