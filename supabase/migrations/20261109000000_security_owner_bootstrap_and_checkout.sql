-- ============================================================================
-- ChefTech POS + Website — Migration 20261109000000
-- Security: Secure Owner Bootstrap, Transactional Checkout, Concurrency Locking,
-- Inventory & Loyalty Ledgers, and Idempotency Protection
-- ============================================================================

-- 1. Add Idempotency Key to Online Orders
alter table public.online_orders
  add column if not exists idempotency_key text unique;

create index if not exists idx_online_orders_idempotency_key
  on public.online_orders(idempotency_key);

-- 2. Inventory Movements Ledger Table
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

alter table public.inventory_movements enable row level security;

create policy "inv_movements_select_staff"
  on public.inventory_movements for select
  to authenticated
  using (public.is_staff());

create policy "inv_movements_insert_staff"
  on public.inventory_movements for insert
  to authenticated
  with check (public.is_admin() or public.get_my_role() = 'CASHIER');

-- 3. Loyalty Transactions Ledger Table
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

alter table public.loyalty_transactions enable row level security;

create policy "loyalty_tx_select_own_or_staff"
  on public.loyalty_transactions for select
  to authenticated
  using (profile_id = (select auth.uid()) or public.is_staff());

-- 4. Remove Automatic Confirmation of Public Signups (Fixes Phase 2.4)
drop trigger if exists on_auth_user_auto_confirm on auth.users;
drop function if exists public.auto_confirm_users();

-- 5. Secure New User Handler (Fixes Phase 2.1: never trust user-supplied role metadata)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Public signups ALWAYS default to CUSTOMER role.
  -- Initial OWNER elevation is handled strictly by public.bootstrap_initial_owner().
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

-- 6. Secure Profile Security Trigger (Fixes Phase 2.1 & 2.2: RBAC enforcement & audit logging)
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
    -- Non-CUSTOMER roles cannot be created directly by public clients
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
    -- Prevent employees from changing their own active status or role
    if (new.role is distinct from old.role) or (new.active is distinct from old.active) then
      if not public.is_owner() then
        raise exception 'Privilege escalation denied: only an active OWNER may modify roles or account status.';
      end if;

      -- Prevent demoting or deactivating the last active OWNER
      if old.role = 'OWNER' and (new.role <> 'OWNER' or new.active = false) then
        select count(*) into v_active_owners
        from public.profiles
        where role = 'OWNER' and active = true and id <> old.id;

        if v_active_owners = 0 then
          raise exception 'Action rejected: cannot demote or deactivate the only active Owner account.';
        end if;
      end if;

      -- Audit log every role and status modification
      insert into public.audit_logs (user_name, action, details)
      values (
        coalesce(v_caller_uid::text, current_user),
        'ROLE_CHANGED',
        format('Profile %s (%s) role changed from %s to %s (active: %s -> %s) by caller %s',
          new.id, coalesce(new.email, new.username, 'unknown'), old.role, new.role, old.active, new.active, coalesce(v_caller_uid::text, current_user))
      );
    end if;

    -- Direct client tampering with loyalty points is strictly forbidden
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

-- 7. Secure Initial Owner Bootstrap Procedure (Fixes Phase 2.1)
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

  -- Lock profiles table to prevent concurrent race conditions
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

-- 8. Atomic Transactional Checkout Function (Fixes Phase 3)
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

  -- Temporary record structure for required inventory
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
