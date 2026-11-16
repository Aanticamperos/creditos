-- Creates a loan and its complete schedule atomically. Run after 001_initial.sql.
create or replace function public.create_loan(
  p_customer_id uuid, p_capital bigint, p_interest_rate numeric,
  p_frequency public.loan_frequency, p_installments_count integer,
  p_disbursement_date date, p_first_payment_date date, p_notes text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_loan_id uuid; v_interest bigint; v_total bigint; v_base bigint; v_amount bigint;
  v_i integer; v_scheduled date; v_due date; v_creator uuid := auth.uid();
begin
  if public.current_role() is null then raise exception 'No autorizado'; end if;
  if not exists (select 1 from public.customers where id=p_customer_id and archived_at is null) then raise exception 'Cliente inválido o archivado'; end if;
  if p_capital <= 0 or p_interest_rate < 0 or p_installments_count < 1 or p_first_payment_date < p_disbursement_date then raise exception 'Condiciones del préstamo inválidas'; end if;
  v_interest := round(p_capital * p_interest_rate / 100.0); v_total := p_capital + v_interest; v_base := floor(v_total / p_installments_count);
  insert into public.loans(customer_id,capital,interest_rate,contractual_interest,contractual_total,frequency,installments_count,disbursement_date,first_payment_date,notes,status,terms_snapshot,created_by)
  values(p_customer_id,p_capital,p_interest_rate,v_interest,v_total,p_frequency,p_installments_count,p_disbursement_date,p_first_payment_date,p_notes,'active',jsonb_build_object('capital',p_capital,'interest_rate',p_interest_rate,'frequency',p_frequency,'installments',p_installments_count),v_creator) returning id into v_loan_id;
  for v_i in 1..p_installments_count loop
    if p_frequency='daily' then
      v_scheduled := p_first_payment_date;
      if v_i > 1 then
        while (select count(*) from generate_series(p_first_payment_date, v_scheduled, interval '1 day') d where extract(dow from d) <> 0 and not exists(select 1 from public.business_holidays h where h.holiday_date=d::date)) < v_i loop v_scheduled := v_scheduled + 1; end loop;
      end if;
      while extract(dow from v_scheduled)=0 or exists(select 1 from public.business_holidays h where h.holiday_date=v_scheduled) loop v_scheduled:=v_scheduled+1; end loop;
    else
      v_scheduled := p_first_payment_date + (v_i-1) * case when p_frequency='weekly' then 7 when p_frequency='biweekly' then 15 else 30 end;
    end if;
    v_due := v_scheduled; while extract(dow from v_due)=0 or exists(select 1 from public.business_holidays h where h.holiday_date=v_due) loop v_due:=v_due+1; end loop;
    v_amount := case when v_i=p_installments_count then v_total-v_base*(p_installments_count-1) else v_base end;
    insert into public.loan_installments(loan_id,installment_number,scheduled_due_date,due_date,original_amount) values(v_loan_id,v_i,v_scheduled,v_due,v_amount);
  end loop;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,new_data) values(v_creator,'loan_created','loan',v_loan_id,jsonb_build_object('capital',p_capital,'total',v_total));
  return v_loan_id;
end $$;
revoke all on function public.create_loan(uuid,bigint,numeric,public.loan_frequency,integer,date,date,text) from public;
grant execute on function public.create_loan(uuid,bigint,numeric,public.loan_frequency,integer,date,date,text) to authenticated;
