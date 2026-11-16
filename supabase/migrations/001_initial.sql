create type public.user_role as enum ('admin','employee');
create type public.loan_frequency as enum ('daily','weekly','biweekly','monthly');
create type public.loan_status as enum ('draft','active','finished','archived','blocked');
create type public.installment_status as enum ('pending','partial','paid','overdue','overdue_partial');
create type public.payment_method as enum ('cash','transfer');

create table public.profiles (id uuid primary key references auth.users(id), full_name text not null, role public.user_role not null default 'employee', active boolean not null default true, created_at timestamptz not null default now());
create table public.customers (id uuid primary key default gen_random_uuid(), document_type text not null, document_number text not null unique, first_names text not null, last_names text not null, phone text not null, email text, address text, notes text, archived_at timestamptz, created_by uuid not null references public.profiles(id), created_at timestamptz not null default now());
create table public.business_holidays (holiday_date date primary key, description text not null, source text default 'manual', created_at timestamptz not null default now());
create table public.loans (id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id), capital bigint not null check(capital > 0), interest_rate numeric(8,4) not null check(interest_rate >= 0), contractual_interest bigint not null, contractual_total bigint not null, frequency public.loan_frequency not null, installments_count int not null check(installments_count > 0), disbursement_date date not null, first_payment_date date not null, notes text, status public.loan_status not null default 'draft', regulatory_snapshot jsonb not null default '{}'::jsonb, terms_snapshot jsonb not null default '{}'::jsonb, created_by uuid not null references public.profiles(id), archived_at timestamptz, created_at timestamptz not null default now());
create table public.loan_installments (id uuid primary key default gen_random_uuid(), loan_id uuid not null references public.loans(id), installment_number int not null, scheduled_due_date date not null, due_date date not null, original_amount bigint not null check(original_amount > 0), paid_amount bigint not null default 0 check(paid_amount >= 0), last_payment_at timestamptz, status public.installment_status not null default 'pending', penalty_frozen boolean not null default false, unique(loan_id, installment_number));
create table public.payments (id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id), received_amount bigint not null check(received_amount > 0), method public.payment_method not null, transfer_reference text, notes text, received_by uuid not null references public.profiles(id), received_at timestamptz not null default now(), reversed_at timestamptz, idempotency_key uuid unique not null default gen_random_uuid());
create table public.payment_allocations (id uuid primary key default gen_random_uuid(), payment_id uuid not null references public.payments(id), installment_id uuid references public.loan_installments(id), penalty_id uuid, amount bigint not null check(amount > 0), created_at timestamptz not null default now(), check((installment_id is null) <> (penalty_id is null)));
create table public.late_penalties (id uuid primary key default gen_random_uuid(), installment_id uuid not null references public.loan_installments(id), period_number int not null, amount bigint not null check(amount > 0), days_counted int not null, paid_amount bigint not null default 0, generated_at timestamptz not null default now(), unique(installment_id, period_number));
alter table public.payment_allocations add constraint allocation_penalty_fk foreign key (penalty_id) references public.late_penalties(id);
create table public.financial_adjustments (id uuid primary key default gen_random_uuid(), loan_id uuid not null references public.loans(id), adjustment_type text not null, amount bigint not null, reason text not null, original_data jsonb, created_by uuid not null references public.profiles(id), created_at timestamptz not null default now());
create table public.audit_logs (id bigint generated always as identity primary key, actor_id uuid references public.profiles(id), action text not null, entity_type text not null, entity_id uuid, old_data jsonb, new_data jsonb, reason text, created_at timestamptz not null default now());
create table public.app_settings (key text primary key, value jsonb not null, updated_by uuid references public.profiles(id), updated_at timestamptz not null default now());
create index on public.loans(customer_id); create index on public.loan_installments(loan_id, due_date); create index on public.payments(customer_id, received_at); create index on public.audit_logs(created_at desc);

create or replace function public.current_role() returns public.user_role language sql stable security definer set search_path=public as $$ select role from public.profiles where id=auth.uid() and active $$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select public.current_role()='admin' $$;
alter table public.profiles enable row level security; alter table public.customers enable row level security; alter table public.loans enable row level security; alter table public.loan_installments enable row level security; alter table public.payments enable row level security; alter table public.payment_allocations enable row level security; alter table public.late_penalties enable row level security; alter table public.financial_adjustments enable row level security; alter table public.audit_logs enable row level security; alter table public.business_holidays enable row level security; alter table public.app_settings enable row level security;
create policy "authenticated read customers" on public.customers for select to authenticated using (true);
create policy "staff create customers" on public.customers for insert to authenticated with check (created_by=auth.uid());
create policy "admin manage customers" on public.customers for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "staff read finance" on public.loans for select to authenticated using (true);
create policy "staff create own loans" on public.loans for insert to authenticated with check(created_by=auth.uid());
create policy "admin manage loans" on public.loans for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "staff read installments" on public.loan_installments for select to authenticated using(true);
create policy "staff read payments" on public.payments for select to authenticated using(true);
create policy "staff read allocations" on public.payment_allocations for select to authenticated using(true);
create policy "staff read penalties" on public.late_penalties for select to authenticated using(true);
create policy "admin audit" on public.audit_logs for select to authenticated using(public.is_admin());
create policy "holiday read" on public.business_holidays for select to authenticated using(true); create policy "admin holidays" on public.business_holidays for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "admin settings" on public.app_settings for all to authenticated using(public.is_admin()) with check(public.is_admin());

create or replace function public.register_payment(p_customer uuid,p_amount bigint,p_method public.payment_method,p_reference text,p_notes text,p_allocations jsonb,p_key uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare pid uuid; total bigint; item jsonb; remaining bigint; target uuid; existing bigint;
begin
 if public.current_role() is null then raise exception 'No autorizado'; end if;
 if p_amount<=0 then raise exception 'El valor debe ser positivo'; end if; select coalesce(sum((x->>'amount')::bigint),0) into total from jsonb_array_elements(p_allocations) x; if total<>p_amount then raise exception 'Las asignaciones deben sumar el pago'; end if;
 insert into public.payments(customer_id,received_amount,method,transfer_reference,notes,received_by,idempotency_key) values(p_customer,p_amount,p_method,p_reference,p_notes,auth.uid(),p_key) returning id into pid;
 for item in select * from jsonb_array_elements(p_allocations) loop
  target := (item->>'installment_id')::uuid; select original_amount-paid_amount into remaining from public.loan_installments where id=target for update; if remaining is null or (item->>'amount')::bigint>remaining then raise exception 'Asignación de cuota inválida'; end if;
  insert into public.payment_allocations(payment_id,installment_id,amount) values(pid,target,(item->>'amount')::bigint);
  update public.loan_installments set paid_amount=paid_amount+(item->>'amount')::bigint,last_payment_at=now(),penalty_frozen=true,status=case when paid_amount+(item->>'amount')::bigint=original_amount then 'paid'::public.installment_status else 'partial'::public.installment_status end where id=target;
 end loop; insert into public.audit_logs(actor_id,action,entity_type,entity_id,new_data) values(auth.uid(),'payment_registered','payment',pid,jsonb_build_object('amount',p_amount)); return pid;
end $$;
