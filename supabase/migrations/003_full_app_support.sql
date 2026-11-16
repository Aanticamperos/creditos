-- Additional RLS policies & performance indexes for full Nexo Crédito operations.
-- Safe to execute idempotently after 001_initial.sql and 002_create_loan.sql.

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'read own profile'
  ) then
    create policy "read own profile" on public.profiles
      for select to authenticated using (id = auth.uid() or public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'admin manage profiles'
  ) then
    create policy "admin manage profiles" on public.profiles
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings' and policyname = 'authenticated read settings'
  ) then
    create policy "authenticated read settings" on public.app_settings
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'financial_adjustments' and policyname = 'authenticated read adjustments'
  ) then
    create policy "authenticated read adjustments" on public.financial_adjustments
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'financial_adjustments' and policyname = 'admin create adjustments'
  ) then
    create policy "admin create adjustments" on public.financial_adjustments
      for insert to authenticated with check (public.is_admin());
  end if;
end $$;

create index if not exists idx_loan_installments_status_due on public.loan_installments(status, due_date);
create index if not exists idx_late_penalties_installment on public.late_penalties(installment_id);
create index if not exists idx_loans_status on public.loans(status);
create index if not exists idx_payments_reversed on public.payments(reversed_at);

create or replace function public.register_payment(
  p_customer uuid, p_amount bigint, p_method public.payment_method,
  p_reference text, p_notes text, p_allocations jsonb, p_key uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare pid uuid; total bigint; item jsonb; remaining bigint; target uuid;
begin
  if public.current_role() is null then raise exception 'No autorizado'; end if;
  if p_amount<=0 then raise exception 'El valor debe ser positivo'; end if;
  select coalesce(sum((x->>'amount')::bigint),0) into total from jsonb_array_elements(p_allocations) x;
  if total<>p_amount then raise exception 'Las asignaciones deben sumar el pago'; end if;
  insert into public.payments(customer_id,received_amount,method,transfer_reference,notes,received_by,idempotency_key)
    values(p_customer,p_amount,p_method,p_reference,p_notes,auth.uid(),p_key) returning id into pid;
  for item in select * from jsonb_array_elements(p_allocations) loop
    target := (item->>'installment_id')::uuid;
    select original_amount-paid_amount into remaining from public.loan_installments where id=target for update;
    if remaining is null or (item->>'amount')::bigint>remaining then raise exception 'Asignación de cuota inválida'; end if;
    insert into public.payment_allocations(payment_id,installment_id,amount) values(pid,target,(item->>'amount')::bigint);
    update public.loan_installments
      set paid_amount=paid_amount+(item->>'amount')::bigint,
          last_payment_at=now(),
          penalty_frozen=true,
          status=case when paid_amount+(item->>'amount')::bigint=original_amount
            then 'paid'::public.installment_status
            else 'partial'::public.installment_status end
      where id=target;
  end loop;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,new_data)
    values(auth.uid(),'payment_registered','payment',pid,jsonb_build_object('amount',p_amount));
  return pid;
end $$;
