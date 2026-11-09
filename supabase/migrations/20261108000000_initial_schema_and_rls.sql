-- ============================================================================
-- ChefTech POS + Website — Unified Supabase PostgreSQL Schema & RLS Policies
-- Migration: 20261108000000_initial_schema_and_rls.sql
-- ============================================================================

create extension if not exists "pgcrypto";

-- 1. User Role Enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'CUSTOMER');
  end if;
end $$;

-- 2. Profiles Table (linked 1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text unique,
  name text not null default '',
  phone text not null default '',
  address text not null default '',
  role public.user_role not null default 'CUSTOMER',
  active boolean not null default true,
  order_count integer not null default 0 check (order_count >= 0),
  loyalty_points integer not null default 0 check (loyalty_points >= 0),
  processed_order_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_username on public.profiles(username);
create index if not exists idx_profiles_phone on public.profiles(phone);

-- 3. Categories Table
create table if not exists public.categories (
  id text primary key,
  name text not null,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 4. Menu Items Table
create table if not exists public.menu_items (
  id text primary key,
  category_id text references public.categories(id) on delete set null,
  name text not null,
  price numeric(12,2) not null check (price >= 0),
  image_url text default '',
  description text default '',
  available boolean not null default true,
  is_addon boolean not null default false,
  modifier_groups jsonb not null default '[]'::jsonb,
  recipes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_menu_items_category_id on public.menu_items(category_id);
create index if not exists idx_menu_items_available on public.menu_items(available);

-- 5. Inventory Table
create table if not exists public.inventory (
  id text primary key,
  name text not null,
  stock numeric(12,3) not null default 0 check (stock >= 0),
  unit text not null default 'pcs',
  cost numeric(12,2) not null default 0 check (cost >= 0),
  low_stock_threshold numeric(12,3) not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 6. Normalized Recipes Table
create table if not exists public.recipes (
  id bigint generated always as identity primary key,
  menu_item_id text not null references public.menu_items(id) on delete cascade,
  inventory_id text not null references public.inventory(id) on delete cascade,
  qty_required numeric(12,3) not null check (qty_required > 0)
);

create index if not exists idx_recipes_menu_item_id on public.recipes(menu_item_id);
create index if not exists idx_recipes_inventory_id on public.recipes(inventory_id);

-- 7. Coupons Table (M-03: discount_percent constrained to 0..100)
create table if not exists public.coupons (
  code text primary key,
  discount_percent numeric(5,2) not null check (discount_percent >= 0 and discount_percent <= 100),
  type text not null default 'promo',
  single_use boolean not null default false,
  assigned_to uuid references public.profiles(id) on delete set null,
  active boolean not null default true,
  used boolean not null default false,
  used_count integer not null default 0 check (used_count >= 0),
  max_uses integer check (max_uses is null or max_uses >= 1),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_coupons_assigned_to on public.coupons(assigned_to);
create index if not exists idx_coupons_active on public.coupons(active);

-- 8. Online Orders Table
create table if not exists public.online_orders (
  id text primary key default gen_random_uuid()::text,
  customer_id uuid references public.profiles(id) on delete set null,
  customer jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  loyalty_redeem_points integer not null default 0 check (loyalty_redeem_points >= 0),
  loyalty_discount numeric(12,2) not null default 0 check (loyalty_discount >= 0),
  coupon_code text,
  total numeric(12,2) not null default 0 check (total >= 0),
  order_type text not null default 'DELIVERY' check (order_type in ('DINE_IN', 'TAKEAWAY', 'DELIVERY')),
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'COMPLETED', 'REJECTED')),
  source text not null default 'website',
  note text default '',
  rejection_reason text,
  sale_id bigint,
  loyalty_issued boolean not null default false,
  accepted_at timestamptz,
  preparing_at timestamptz,
  out_for_delivery_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_online_orders_customer_id on public.online_orders(customer_id);
create index if not exists idx_online_orders_status on public.online_orders(status);
create index if not exists idx_online_orders_created_at on public.online_orders(created_at desc);

-- 9. Online Order Items Table
create table if not exists public.online_order_items (
  id bigint generated always as identity primary key,
  order_id text not null references public.online_orders(id) on delete cascade,
  menu_item_id text references public.menu_items(id) on delete set null,
  name text not null,
  price numeric(12,2) not null check (price >= 0),
  qty integer not null check (qty >= 1)
);

create index if not exists idx_online_order_items_order_id on public.online_order_items(order_id);

-- 10. POS Sales & Sale Items
create table if not exists public.sales (
  id bigint primary key,
  date timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  total numeric(12,2) not null default 0 check (total >= 0),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  discount_type text default 'PERCENT',
  discount_val numeric(12,2) default 0,
  loyalty_redeem_amt numeric(12,2) default 0,
  loyalty_redeem_pts integer default 0,
  payment_method text not null default 'CASH',
  order_type text not null default 'DINE_IN',
  customer_id text,
  customer_name text,
  customer_phone text,
  customer_address text,
  cashier text,
  note text,
  refunded_amount numeric(12,2) default 0,
  refunded_qty_map jsonb default '{}'::jsonb,
  reopened boolean default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_date on public.sales(date desc);

create table if not exists public.sale_items (
  id bigint generated always as identity primary key,
  sale_id bigint not null references public.sales(id) on delete cascade,
  menu_item_id text references public.menu_items(id) on delete set null,
  name text not null,
  price numeric(12,2) not null check (price >= 0),
  qty integer not null check (qty >= 1)
);

create index if not exists idx_sale_items_sale_id on public.sale_items(sale_id);

-- 11. Refunds
create table if not exists public.refunds (
  id bigint primary key,
  sale_id bigint not null,
  date timestamptz not null default now(),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  items jsonb not null default '[]'::jsonb,
  reason text,
  processed_by text,
  restock boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists idx_refunds_sale_id on public.refunds(sale_id);

-- 12. POS CRM Customers
create table if not exists public.customers (
  id text primary key,
  name text not null,
  phone text not null,
  address text default '',
  total_spent numeric(12,2) not null default 0,
  visits integer not null default 0,
  last_visit timestamptz,
  points integer not null default 0 check (points >= 0),
  tier text not null default 'Bronze',
  notes text default '',
  history jsonb not null default '[]'::jsonb,
  profile_id uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_customers_phone on public.customers(phone);
create index if not exists idx_customers_profile_id on public.customers(profile_id);

-- 13. Held Orders & Table Orders
create table if not exists public.held_orders (
  id bigint primary key,
  date timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  note text,
  order_type text,
  customer jsonb,
  discount jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.table_orders (
  table_id text primary key,
  table_name text,
  items jsonb not null default '[]'::jsonb,
  status text not null default 'OPEN',
  waiter text,
  guests integer default 1,
  opened_at timestamptz not null default now(),
  note text,
  updated_at timestamptz not null default now()
);

-- 14. Suppliers, Expenses, Staff, Shifts, Audit Logs
create table if not exists public.suppliers (
  id text primary key,
  name text not null,
  contact text,
  phone text,
  email text,
  items_supplied text,
  balance numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id bigint primary key,
  date timestamptz not null default now(),
  category text not null,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  description text,
  paid_to text,
  recorded_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.staff (
  id text primary key,
  name text not null,
  role text not null,
  phone text,
  salary numeric(12,2) not null default 0,
  join_date text,
  status text not null default 'ACTIVE',
  advances jsonb not null default '[]'::jsonb,
  attendance jsonb not null default '[]'::jsonb,
  payments jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.shifts (
  id bigint primary key,
  user_name text not null,
  start_time timestamptz not null default now(),
  end_time timestamptz,
  opening_cash numeric(12,2) not null default 0,
  closing_cash numeric(12,2),
  expected_cash numeric(12,2),
  notes text,
  status text not null default 'OPEN',
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null default now(),
  user_name text,
  action text not null,
  details text
);

-- 15. Settings, Banners & Loyalty Rewards
create table if not exists public.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.banners (
  id text primary key default gen_random_uuid()::text,
  title text default '',
  subtitle text default '',
  image_url text not null,
  link text default '',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.loyalty_rewards (
  id text primary key,
  name text not null,
  points_cost integer not null check (points_cost > 0),
  reward_type text not null,
  discount_value numeric(12,2) not null default 0,
  menu_item_id text,
  min_order numeric(12,2) not null default 0,
  active boolean not null default true,
  description text default '',
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Helper Security Functions (SECURITY DEFINER with locked search_path)
-- ============================================================================

create or replace function public.get_my_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.profiles
  where id = (select auth.uid())
    and active = true
  limit 1;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'OWNER'
      and active = true
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('OWNER', 'MANAGER')
      and active = true
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('OWNER', 'MANAGER', 'CASHIER', 'WAITER')
      and active = true
  );
$$;

create or replace function public.has_any_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where role = 'OWNER'
  );
$$;

-- ============================================================================
-- Profile Guard Trigger (Fixes S-02 & S-05: blocks self-promotion & loyalty spoofing)
-- ============================================================================

create or replace function public.enforce_profile_security()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_is_service boolean := (v_jwt_role = 'service_role') or (current_user in ('postgres', 'service_role', 'supabase_admin'));
begin
  new.updated_at := now();

  if v_is_service then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Only allow non-CUSTOMER role on insert if caller is an existing OWNER
    -- OR if no OWNER exists yet in the entire system (first-run bootstrap).
    if new.role <> 'CUSTOMER' then
      if not (public.is_owner() or (new.role = 'OWNER' and not public.has_any_owner())) then
        raise exception 'Privilege escalation denied: cannot assign privileged role.';
      end if;
    end if;
    -- Clients cannot seed their own loyalty counters on signup
    new.order_count := 0;
    new.loyalty_points := 0;
    new.processed_order_ids := '{}';
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Only OWNER can change role or active status
    if (new.role is distinct from old.role) or (new.active is distinct from old.active) then
      if not public.is_owner() then
        raise exception 'Privilege escalation denied: only OWNER may modify role or active status.';
      end if;
    end if;

    -- Clients cannot directly modify order_count, loyalty_points, or processed_order_ids
    -- (those are updated exclusively via service_role Edge Functions)
    if (new.order_count is distinct from old.order_count)
       or (new.loyalty_points is distinct from old.loyalty_points)
       or (new.processed_order_ids is distinct from old.processed_order_ids) then
      raise exception 'Direct modification of loyalty counters is forbidden. Use Edge Functions.';
    end if;

    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_profile_security on public.profiles;
create trigger trg_enforce_profile_security
before insert or update on public.profiles
for each row
execute function public.enforce_profile_security();

-- Auto-create profile row when a new auth.users entry is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested_role text := coalesce(new.raw_user_meta_data->>'role', 'CUSTOMER');
  v_final_role public.user_role := 'CUSTOMER';
begin
  if v_requested_role = 'OWNER' and not public.has_any_owner() then
    v_final_role := 'OWNER';
  end if;

  insert into public.profiles (id, email, username, name, phone, address, role, active)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), ''),
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'phone', ''),
    coalesce(new.raw_user_meta_data->>'address', ''),
    v_final_role,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- Auto-confirm user emails when require_email_verification is disabled or for internal staff logins
create or replace function public.auto_confirm_users()
returns trigger
language plpgsql
security definer
as $$
declare
  v_require_verification boolean := false;
begin
  select coalesce((value->>'enabled')::boolean, false) into v_require_verification
  from public.settings
  where key = 'require_email_verification';

  if not v_require_verification or new.email like '%@cheftech-pos.local' then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_auto_confirm on auth.users;
create trigger on_auth_user_auto_confirm
before insert on auth.users
for each row
execute function public.auto_confirm_users();

-- ============================================================================
-- Enable Row Level Security (RLS) on ALL Tables (Appendix A3)
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.inventory enable row level security;
alter table public.recipes enable row level security;
alter table public.coupons enable row level security;
alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.refunds enable row level security;
alter table public.customers enable row level security;
alter table public.held_orders enable row level security;
alter table public.table_orders enable row level security;
alter table public.suppliers enable row level security;
alter table public.expenses enable row level security;
alter table public.staff enable row level security;
alter table public.shifts enable row level security;
alter table public.audit_logs enable row level security;
alter table public.settings enable row level security;
alter table public.banners enable row level security;
alter table public.loyalty_rewards enable row level security;

-- 1. profiles policies (Fixes S-02, H-06)
create policy "profiles_select_own_or_staff"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()) or public.is_staff());

create policy "profiles_insert_own_or_owner"
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()) or public.is_owner());

create policy "profiles_update_own_or_owner"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()) or public.is_owner())
  with check (id = (select auth.uid()) or public.is_owner());

create policy "profiles_delete_owner_only"
  on public.profiles for delete
  to authenticated
  using (public.is_owner());

-- 2. categories & menu_items & banners & loyalty_rewards (Public read, Admin write)
create policy "categories_select_public"
  on public.categories for select
  to anon, authenticated
  using (true);

create policy "categories_write_admin"
  on public.categories for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "menu_items_select_public"
  on public.menu_items for select
  to anon, authenticated
  using (true);

create policy "menu_items_write_admin"
  on public.menu_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "banners_select_public"
  on public.banners for select
  to anon, authenticated
  using (true);

create policy "banners_write_admin"
  on public.banners for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "loyalty_rewards_select_public"
  on public.loyalty_rewards for select
  to anon, authenticated
  using (true);

create policy "loyalty_rewards_write_admin"
  on public.loyalty_rewards for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 3. inventory & recipes (Staff read, Admin/Cashier update stock, Admin full write)
create policy "inventory_select_staff"
  on public.inventory for select
  to authenticated
  using (public.is_staff());

create policy "inventory_write_staff"
  on public.inventory for all
  to authenticated
  using (public.is_admin() or public.get_my_role() = 'CASHIER')
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "recipes_select_staff"
  on public.recipes for select
  to authenticated
  using (public.is_staff());

create policy "recipes_write_admin"
  on public.recipes for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 4. coupons (Fixes S-06: Authenticated users can view active promo or own assigned coupons; ONLY Admin can insert/update/delete; consumption is via Edge Function)
create policy "coupons_select_authenticated"
  on public.coupons for select
  to authenticated
  using (
    public.is_staff()
    or (active = true and used = false and (assigned_to is null or assigned_to = (select auth.uid())))
  );

create policy "coupons_write_admin_only"
  on public.coupons for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 5. online_orders & online_order_items (Fixes S-03 & S-04: Private to owning customer or staff; order creation goes via place-order Edge Function or staff POS)
create policy "online_orders_select_own_or_staff"
  on public.online_orders for select
  to authenticated
  using (customer_id = (select auth.uid()) or public.is_staff());

create policy "online_orders_insert_staff_only"
  on public.online_orders for insert
  to authenticated
  with check (public.is_staff());

create policy "online_orders_update_staff_only"
  on public.online_orders for update
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "online_orders_delete_admin_only"
  on public.online_orders for delete
  to authenticated
  using (public.is_admin());

create policy "online_order_items_select_own_or_staff"
  on public.online_order_items for select
  to authenticated
  using (
    public.is_staff()
    or exists (
      select 1 from public.online_orders o
      where o.id = online_order_items.order_id
        and o.customer_id = (select auth.uid())
    )
  );

create policy "online_order_items_write_staff_only"
  on public.online_order_items for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- 6. POS Operational Tables (sales, sale_items, refunds, customers, held_orders, table_orders, shifts, audit_logs)
create policy "sales_staff_access"
  on public.sales for all
  to authenticated
  using (public.is_admin() or public.get_my_role() = 'CASHIER')
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "sale_items_staff_access"
  on public.sale_items for all
  to authenticated
  using (public.is_admin() or public.get_my_role() = 'CASHIER')
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "refunds_staff_access"
  on public.refunds for all
  to authenticated
  using (public.is_admin() or public.get_my_role() = 'CASHIER')
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "customers_staff_access"
  on public.customers for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "held_orders_staff_access"
  on public.held_orders for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "table_orders_staff_access"
  on public.table_orders for all
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "shifts_staff_access"
  on public.shifts for all
  to authenticated
  using (public.is_admin() or public.get_my_role() = 'CASHIER')
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "audit_logs_select_admin"
  on public.audit_logs for select
  to authenticated
  using (public.is_admin());

create policy "audit_logs_insert_staff"
  on public.audit_logs for insert
  to authenticated
  with check (public.is_staff());

-- 7. Financial & HR Tables (suppliers, expenses, staff) — Admin only (Waiters/Cashiers cannot read payroll or P&L expenses)
create policy "suppliers_admin_only"
  on public.suppliers for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "expenses_admin_only"
  on public.expenses for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "staff_admin_only"
  on public.staff for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 8. Settings (Public read of safe public keys like restaurant_info & require_email_verification; Admin write)
create policy "settings_select_public"
  on public.settings for select
  to anon, authenticated
  using (key in ('restaurant_info', 'require_email_verification', 'loyalty_config') or public.is_staff());

create policy "settings_write_admin"
  on public.settings for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Default public settings seed
insert into public.settings (key, value)
values
  ('require_email_verification', '{"enabled": true}'::jsonb),
  ('restaurant_info', '{"name": "Your Restaurant Name", "phone": "0300-0000000", "addressLine1": "123 Main Street", "addressLine2": "Your City", "accountTitle": "Account Holder Name"}'::jsonb)
on conflict (key) do nothing;

-- ============================================================================
-- Enable Supabase Realtime on Live Tables (Appendix A5)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.online_orders;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.menu_items;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.categories;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.coupons;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.banners;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
