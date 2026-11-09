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
  idempotency_key text unique,
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
create index if not exists idx_online_orders_idempotency_key on public.online_orders(idempotency_key);

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

-- 16. Inventory Movements Ledger Table
create table if not exists public.inventory_movements (
  id bigint generated always as identity primary key,
  inventory_id text not null references public.inventory(id) on delete cascade,
  change_qty numeric(12,3) not null,
  new_stock numeric(12,3) not null,
  movement_type text not null check (
    movement_type in ('PURCHASE', 'SALE_RECIPE', 'ONLINE_ORDER', 'ADJUSTMENT', 'REFUND_RESTOCK', 'VOID_RESTOCK')
  ),
  reference_id text,
  notes text default '',
  recorded_by text default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_inv_movements_inv_id on public.inventory_movements(inventory_id);
create index if not exists idx_inv_movements_created on public.inventory_movements(created_at desc);
create index if not exists idx_inv_movements_reference on public.inventory_movements(reference_id);

-- 17. Loyalty Transactions Ledger Table
create table if not exists public.loyalty_transactions (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  points_change integer not null,
  new_balance integer not null check (new_balance >= 0),
  transaction_type text not null check (
    transaction_type in ('EARN_ORDER', 'REDEEM_CHECKOUT', 'ADMIN_ADJUST', 'REFUND_REVERSAL')
  ),
  reference_id text,
  description text default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_loyalty_tx_profile_id on public.loyalty_transactions(profile_id);
create index if not exists idx_loyalty_tx_created on public.loyalty_transactions(created_at desc);

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
  v_caller_uid uuid := auth.uid();
  v_active_owners integer;
begin
  new.updated_at := now();

  if v_is_service then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role <> 'CUSTOMER' then
      if not public.is_owner() then
        raise exception 'Privilege escalation denied: only an existing OWNER can assign privileged roles.';
      end if;
    end if;
    new.order_count := 0;
    new.loyalty_points := 0;
    new.processed_order_ids := '{}';
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if (new.role is distinct from old.role) or (new.active is distinct from old.active) then
      if not public.is_owner() then
        raise exception 'Privilege escalation denied: only an active OWNER may modify roles or account status.';
      end if;

      if old.role = 'OWNER' and (new.role <> 'OWNER' or new.active = false) then
        select count(*) into v_active_owners
        from public.profiles
        where role = 'OWNER' and active = true and id <> old.id;

        if v_active_owners = 0 then
          raise exception 'Action rejected: cannot demote or deactivate the only active Owner account.';
        end if;
      end if;

      insert into public.audit_logs (user_name, action, details)
      values (
        coalesce(v_caller_uid::text, current_user),
        'ROLE_CHANGED',
        format('Profile %s (%s) role changed from %s to %s (active: %s -> %s) by caller %s',
          new.id, coalesce(new.email, new.username, 'unknown'), old.role, new.role, old.active, new.active, coalesce(v_caller_uid::text, current_user))
      );
    end if;

    if (new.order_count is distinct from old.order_count)
       or (new.loyalty_points is distinct from old.loyalty_points)
       or (new.processed_order_ids is distinct from old.processed_order_ids) then
      raise exception 'Direct modification of loyalty counters is forbidden. Use Edge Functions / database procedures.';
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
-- Public registrations ALWAYS default to CUSTOMER; initial OWNER elevation is via bootstrap_initial_owner()
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, username, name, phone, address, role, active)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), ''),
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'phone', ''),
    coalesce(new.raw_user_meta_data->>'address', ''),
    'CUSTOMER',
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

-- Secure Initial Owner Bootstrap Procedure
create or replace function public.bootstrap_initial_owner(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing_owners integer;
  v_clean_email text := trim(lower(coalesce(p_email, '')));
begin
  if v_clean_email = '' then
    raise exception 'Email address is required to bootstrap the Owner account.';
  end if;

  perform 1 from public.profiles where role = 'OWNER' for update;

  select count(*) into v_existing_owners from public.profiles where role = 'OWNER';
  if v_existing_owners > 0 then
    raise exception 'Initial owner setup has already been completed. An OWNER account already exists in this system.';
  end if;

  select id into v_user_id from public.profiles where lower(email) = v_clean_email limit 1;
  if v_user_id is null then
    raise exception 'No registered user profile found for email "%". Please sign up the owner account first, then run bootstrap.', v_clean_email;
  end if;

  update public.profiles
  set role = 'OWNER', active = true, updated_at = now()
  where id = v_user_id;

  insert into public.audit_logs (user_name, action, details)
  values (v_clean_email, 'OWNER_BOOTSTRAPPED', format('User %s (%s) elevated to initial OWNER via secure bootstrap.', v_user_id, v_clean_email));

  return jsonb_build_object(
    'success', true,
    'userId', v_user_id,
    'email', v_clean_email,
    'role', 'OWNER',
    'message', 'Initial Owner successfully bootstrapped.'
  );
end;
$$;

revoke execute on function public.bootstrap_initial_owner(text) from public, anon;
grant execute on function public.bootstrap_initial_owner(text) to authenticated, service_role;

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
alter table public.inventory_movements enable row level security;
alter table public.loyalty_transactions enable row level security;

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

create policy "inv_movements_select_staff"
  on public.inventory_movements for select
  to authenticated
  using (public.is_staff());

create policy "inv_movements_insert_staff"
  on public.inventory_movements for insert
  to authenticated
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

create policy "loyalty_tx_select_own_or_staff"
  on public.loyalty_transactions for select
  to authenticated
  using (profile_id = (select auth.uid()) or public.is_staff());

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

-- ============================================================================
-- Atomic Transactional Checkout Function (Phase 3)
-- ============================================================================
create or replace function public.process_online_order_checkout(
  p_idempotency_key text,
  p_customer_id uuid,
  p_customer jsonb,
  p_items jsonb,
  p_order_type text,
  p_coupon_code text default null,
  p_loyalty_redeem_points integer default 0,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_order record;
  v_order_id text;
  v_order_type text := upper(coalesce(p_order_type, 'DELIVERY'));
  v_customer_name text := trim(coalesce(p_customer->>'name', ''));
  v_customer_phone text := trim(coalesce(p_customer->>'phone', ''));
  v_customer_address text := trim(coalesce(p_customer->>'address', ''));

  v_subtotal numeric(12,2) := 0;
  v_discount_amount numeric(12,2) := 0;
  v_loyalty_discount numeric(12,2) := 0;
  v_applied_points integer := 0;
  v_total numeric(12,2) := 0;

  v_raw_item jsonb;
  v_item_id text;
  v_item_qty integer;
  v_db_item record;
  v_unit_price numeric(12,2);
  v_item_name text;

  v_recipe_ing jsonb;
  v_inv_id text;
  v_needed_qty numeric(12,3);

  v_req record;
  v_inv_record record;

  v_coupon record;
  v_clamped_pct numeric(5,2);
  v_next_uses integer;
  v_mark_used boolean;

  v_profile record;
  v_avail_pts integer;
  v_max_redeem numeric(12,2);

  v_verified_items jsonb := '[]'::jsonb;
  v_created_order record;
  v_item_row jsonb;
begin
  -- 1. Idempotency Check (Phase 3.5)
  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select * into v_existing_order
    from public.online_orders
    where idempotency_key = trim(p_idempotency_key);

    if found then
      return jsonb_build_object(
        'order', row_to_json(v_existing_order),
        'replayed', true
      );
    end if;
  end if;

  -- 2. Validate Order Type & Customer Details
  if v_order_type not in ('DINE_IN', 'TAKEAWAY', 'DELIVERY') then
    v_order_type := 'DELIVERY';
  end if;

  if v_customer_name = '' or v_customer_phone = '' then
    raise exception 'Customer name and phone number are required.';
  end if;

  if v_order_type = 'DELIVERY' and v_customer_address = '' then
    raise exception 'Delivery address is required for delivery orders.';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  -- 3. Create temporary tables for order calculation & recipe stock tracking
  create temporary table if not exists _tmp_order_items (
    menu_item_id text not null,
    name text not null,
    price numeric(12,2) not null,
    qty integer not null
  ) on commit drop;
  delete from _tmp_order_items;

  create temporary table if not exists _tmp_stock_needed (
    inventory_id text primary key,
    needed_qty numeric(12,3) not null
  ) on commit drop;
  delete from _tmp_stock_needed;

  -- 4. Validate Items & Prices from Database (Phase 3.1)
  for v_raw_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := trim(coalesce(v_raw_item->>'menu_item_id', v_raw_item->>'menuItemId', v_raw_item->>'id', ''));
    v_item_qty := floor(coalesce((v_raw_item->>'qty')::numeric, 0))::integer;

    if v_item_id = '' or v_item_qty < 1 or v_item_qty > 500 then
      raise exception 'Invalid item or quantity in order.';
    end if;

    select * into v_db_item
    from public.menu_items
    where id = v_item_id;

    if not found then
      raise exception 'Menu item "%" was not found.', coalesce(v_raw_item->>'name', v_item_id);
    end if;

    if v_db_item.available = false then
      raise exception '"%" is currently sold out / unavailable.', v_db_item.name;
    end if;

    v_unit_price := v_db_item.price;
    v_item_name := v_db_item.name;

    -- Add modifier price if modifier groups present
    if jsonb_typeof(v_raw_item->'selectedModifiers') = 'array' and jsonb_array_length(v_raw_item->'selectedModifiers') > 0 then
      declare
        v_sel jsonb;
        v_opt_name text;
        v_grp jsonb;
        v_opt jsonb;
        v_labels text[] := '{}';
      begin
        for v_sel in select * from jsonb_array_elements(v_raw_item->'selectedModifiers')
        loop
          v_opt_name := coalesce(v_sel->>'optionName', '');
          for v_grp in select * from jsonb_array_elements(v_db_item.modifier_groups)
          loop
            for v_opt in select * from jsonb_array_elements(coalesce(v_grp->'options', '[]'::jsonb))
            loop
              if coalesce(v_opt->>'name', '') = v_opt_name then
                v_unit_price := v_unit_price + greatest(0, coalesce((v_opt->>'price')::numeric, 0));
                v_labels := array_append(v_labels, v_opt_name);
                exit;
              end if;
            end loop;
          end loop;
        end loop;
        if array_length(v_labels, 1) > 0 then
          v_item_name := v_item_name || ' (' || array_to_string(v_labels, ', ') || ')';
        end if;
      end;
    end if;

    v_subtotal := v_subtotal + (v_unit_price * v_item_qty);

    insert into _tmp_order_items (menu_item_id, name, price, qty)
    values (v_item_id, v_item_name, v_unit_price, v_item_qty);

    -- Accumulate Recipe Requirements from recipes jsonb or normalized recipes table
    if jsonb_typeof(v_db_item.recipes) = 'array' and jsonb_array_length(v_db_item.recipes) > 0 then
      for v_recipe_ing in select * from jsonb_array_elements(v_db_item.recipes)
      loop
        v_inv_id := coalesce(v_recipe_ing->>'inventoryId', v_recipe_ing->>'inventory_id', '');
        v_needed_qty := greatest(0, coalesce((v_recipe_ing->>'qty')::numeric, (v_recipe_ing->>'qty_required')::numeric, 0)) * v_item_qty;
        if v_inv_id <> '' and v_needed_qty > 0 then
          insert into _tmp_stock_needed (inventory_id, needed_qty)
          values (v_inv_id, v_needed_qty)
          on conflict (inventory_id)
          do update set needed_qty = _tmp_stock_needed.needed_qty + excluded.needed_qty;
        end if;
      end loop;
    else
      -- Check normalized recipes table
      for v_req in select inventory_id, (qty_required * v_item_qty) as req_qty from public.recipes where menu_item_id = v_item_id
      loop
        insert into _tmp_stock_needed (inventory_id, needed_qty)
        values (v_req.inventory_id, v_req.req_qty)
        on conflict (inventory_id)
        do update set needed_qty = _tmp_stock_needed.needed_qty + excluded.needed_qty;
      end loop;
    end if;
  end loop;

  v_subtotal := round(v_subtotal, 2);

  -- 5. Lock Inventory Rows in Sorted Order & Verify Stock (Phase 3.2 - deadlock prevention)
  for v_req in select inventory_id, needed_qty from _tmp_stock_needed order by inventory_id
  loop
    select id, name, stock into v_inv_record
    from public.inventory
    where id = v_req.inventory_id
    for update;

    if not found then
      raise exception 'Required inventory ingredient "%" was not found in inventory.', v_req.inventory_id;
    end if;

    if v_inv_record.stock < v_req.needed_qty then
      raise exception 'Insufficient stock for ingredient "%" to fulfill this order (available: %, needed: %).',
        v_inv_record.name, v_inv_record.stock, v_req.needed_qty;
    end if;

    -- Deduct stock atomically inside transaction
    update public.inventory
    set stock = stock - v_req.needed_qty, updated_at = now()
    where id = v_req.inventory_id;

    -- Record in inventory movements ledger
    insert into public.inventory_movements (
      inventory_id, change_qty, new_stock, movement_type, reference_id, notes, recorded_by
    )
    values (
      v_req.inventory_id,
      -v_req.needed_qty,
      v_inv_record.stock - v_req.needed_qty,
      'ONLINE_ORDER',
      p_idempotency_key,
      format('Online order checkout consumption for %s', v_customer_name),
      coalesce(p_customer_id::text, 'guest')
    );
  end loop;

  -- 6. Atomic Coupon Validation & Usage Increment (Phase 3.3)
  if p_coupon_code is not null and trim(p_coupon_code) <> '' then
    select * into v_coupon
    from public.coupons
    where code = upper(trim(p_coupon_code))
    for update;

    if not found or v_coupon.active = false or v_coupon.used = true then
      raise exception 'Invalid, expired, or already-used coupon code.';
    end if;

    if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
      raise exception 'This coupon code has expired.';
    end if;

    if v_coupon.assigned_to is not null then
      if p_customer_id is null or v_coupon.assigned_to <> p_customer_id then
        raise exception 'This coupon code is assigned to a specific registered customer account.';
      end if;
    end if;

    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      raise exception 'This coupon has reached its maximum redemption limit.';
    end if;

    v_clamped_pct := least(100::numeric, greatest(0::numeric, v_coupon.discount_percent));
    v_discount_amount := round((v_subtotal * v_clamped_pct) / 100, 2);

    v_next_uses := coalesce(v_coupon.used_count, 0) + 1;
    v_mark_used := v_coupon.single_use or (v_coupon.max_uses is not null and v_next_uses >= v_coupon.max_uses);

    update public.coupons
    set
      used_count = v_next_uses,
      used = v_mark_used,
      active = case when v_mark_used then false else v_coupon.active end,
      updated_at = now()
    where code = v_coupon.code;
  end if;

  -- 7. Atomic Loyalty Points Validation & Deduction (Phase 3.4)
  if p_loyalty_redeem_points > 0 then
    if p_customer_id is null then
      raise exception 'Please sign in to redeem loyalty points.';
    end if;

    select * into v_profile
    from public.profiles
    where id = p_customer_id
    for update;

    if not found then
      raise exception 'Customer profile not found for loyalty redemption.';
    end if;

    v_avail_pts := coalesce(v_profile.loyalty_points, 0);
    if p_loyalty_redeem_points > v_avail_pts then
      raise exception 'Insufficient loyalty points balance (available: %, requested: %).', v_avail_pts, p_loyalty_redeem_points;
    end if;

    v_max_redeem := greatest(0::numeric, v_subtotal - v_discount_amount);
    v_loyalty_discount := least(p_loyalty_redeem_points::numeric, v_max_redeem);
    v_applied_points := floor(v_loyalty_discount)::integer;

    if v_applied_points > 0 then
      update public.profiles
      set loyalty_points = v_avail_pts - v_applied_points, updated_at = now()
      where id = p_customer_id;

      insert into public.loyalty_transactions (
        profile_id, points_change, new_balance, transaction_type, reference_id, description
      )
      values (
        p_customer_id,
        -v_applied_points,
        v_avail_pts - v_applied_points,
        'REDEEM_CHECKOUT',
        p_idempotency_key,
        format('Redeemed %s points on online order', v_applied_points)
      );
    end if;
  end if;

  -- 8. Compute Post-Discount Grand Total & Enforce Delivery Minimum (Phase 3.1)
  v_total := greatest(0::numeric, round(v_subtotal - v_discount_amount - v_loyalty_discount, 2));

  if v_order_type = 'DELIVERY' and v_total < 500 then
    raise exception 'Minimum order for delivery is Rs. 500 after discounts (current total: Rs. %).', v_total;
  end if;

  -- 9. Insert Created Online Order
  v_order_id := 'ORD-' || (extract(epoch from now()) * 1000)::bigint || '-' || upper(substr(md5(random()::text), 1, 5));

  select jsonb_agg(row_to_json(t)) into v_verified_items
  from _tmp_order_items t;

  insert into public.online_orders (
    id,
    customer_id,
    customer,
    items,
    subtotal,
    discount_amount,
    loyalty_redeem_points,
    loyalty_discount,
    coupon_code,
    total,
    order_type,
    status,
    source,
    note,
    idempotency_key,
    created_at,
    updated_at
  )
  values (
    v_order_id,
    p_customer_id,
    jsonb_build_object('name', v_customer_name, 'phone', v_customer_phone, 'address', v_customer_address),
    coalesce(v_verified_items, '[]'::jsonb),
    v_subtotal,
    v_discount_amount,
    v_applied_points,
    v_loyalty_discount,
    nullif(trim(p_coupon_code), ''),
    v_total,
    v_order_type,
    'PENDING',
    'website',
    trim(p_note),
    nullif(trim(p_idempotency_key), ''),
    now(),
    now()
  )
  returning * into v_created_order;

  -- 10. Insert Line Items into online_order_items
  for v_item_row in select * from jsonb_array_elements(v_verified_items)
  loop
    insert into public.online_order_items (order_id, menu_item_id, name, price, qty)
    values (
      v_order_id,
      v_item_row->>'menu_item_id',
      v_item_row->>'name',
      (v_item_row->>'price')::numeric,
      (v_item_row->>'qty')::integer
    );
  end loop;

  return jsonb_build_object(
    'order', row_to_json(v_created_order),
    'replayed', false
  );
end;
$$;

revoke execute on function public.process_online_order_checkout from public, anon;
grant execute on function public.process_online_order_checkout to service_role;
