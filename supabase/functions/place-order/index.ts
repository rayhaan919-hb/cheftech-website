import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MIN_DELIVERY_ORDER = 500;

interface OrderItemInput {
  id?: string;
  menu_item_id?: string;
  menuItemId?: string;
  name?: string;
  qty: number;
  selectedModifiers?: Array<{ groupName?: string; optionName: string }>;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server configuration missing.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Optional user authentication: support both logged-in users & guest checkout
    const authHeader = req.headers.get('Authorization');
    let user = null;

    if (authHeader) {
      try {
        const userClient = createClient(supabaseUrl, supabaseAnonKey, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: userData } = await userClient.auth.getUser();
        if (userData?.user) {
          user = userData.user;
        }
      } catch (_e) {
        // Fall back to guest checkout if token is invalid or anonymous
      }
    }

    // H-05: Enforce email verification for authenticated users unless explicitly disabled in settings
    if (user) {
      const { data: verifySetting } = await adminClient
        .from('settings')
        .select('value')
        .eq('key', 'require_email_verification')
        .maybeSingle();

      const requireEmailVerification = verifySetting?.value?.enabled !== false;
      if (requireEmailVerification && !user.email_confirmed_at) {
        return new Response(
          JSON.stringify({
            error: 'Please verify your email (check your inbox) before placing an order.',
            code: 'EMAIL_NOT_VERIFIED',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const body = await req.json();
    const rawItems: OrderItemInput[] = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Order must contain at least one item.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderTypeRaw = String(body.order_type || body.orderType || 'DELIVERY').toUpperCase();
    const orderType = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderTypeRaw)
      ? orderTypeRaw
      : 'DELIVERY';

    const customerName = String(body.customer?.name || '').trim();
    const customerPhone = String(body.customer?.phone || '').trim();
    const customerAddress = String(body.customer?.address || '').trim();

    if (!customerName || !customerPhone) {
      return new Response(
        JSON.stringify({ error: 'Customer name and phone number are required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (orderType === 'DELIVERY' && !customerAddress) {
      return new Response(
        JSON.stringify({ error: 'Delivery address is required for delivery orders.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // S-04 & M-07: Fetch menu items from database and verify availability, stock, and authoritative prices
    const requestedIds = Array.from(
      new Set(
        rawItems
          .map((item) => String(item.menu_item_id || item.menuItemId || item.id || '').trim())
          .filter(Boolean)
      )
    );

    const { data: dbMenuItems, error: menuErr } = await adminClient
      .from('menu_items')
      .select('id, name, price, available, modifier_groups, recipes')
      .in('id', requestedIds);

    if (menuErr || !dbMenuItems) {
      return new Response(
        JSON.stringify({ error: 'Failed to load menu catalogue for price verification.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const menuById = new Map(dbMenuItems.map((m) => [String(m.id), m]));

    // Load inventory for recipe stock verification (M-07)
    const { data: inventoryRows } = await adminClient
      .from('inventory')
      .select('id, name, stock');
    const stockById = new Map(
      (inventoryRows ?? []).map((inv) => [String(inv.id), { name: inv.name, stock: Number(inv.stock) }])
    );
    const requiredStock = new Map<string, number>();

    let subtotal = 0;
    const verifiedItems: Array<{
      menu_item_id: string;
      name: string;
      price: number;
      qty: number;
    }> = [];

    for (const raw of rawItems) {
      const itemId = String(raw.menu_item_id || raw.menuItemId || raw.id || '').trim();
      const qty = Math.floor(Number(raw.qty));
      if (!itemId || !Number.isFinite(qty) || qty < 1 || qty > 500) {
        return new Response(
          JSON.stringify({ error: 'Invalid item quantity in cart.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const dbItem = menuById.get(itemId);
      if (!dbItem) {
        return new Response(
          JSON.stringify({ error: `Menu item "${raw.name || itemId}" was not found.` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (dbItem.available === false) {
        return new Response(
          JSON.stringify({ error: `"${dbItem.name}" is currently unavailable / sold out.` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Compute verified unit price from DB base price + verified DB modifier options
      let unitPrice = Number(dbItem.price);
      let displayName = String(dbItem.name);

      if (Array.isArray(raw.selectedModifiers) && Array.isArray(dbItem.modifier_groups)) {
        const chosenLabels: string[] = [];
        for (const sel of raw.selectedModifiers) {
          for (const grp of dbItem.modifier_groups) {
            const opt = Array.isArray(grp.options)
              ? grp.options.find((o: { name: string; price?: number }) => o.name === sel.optionName)
              : null;
            if (opt) {
              unitPrice += Math.max(0, Number(opt.price || 0));
              chosenLabels.push(opt.name);
              break;
            }
          }
        }
        if (chosenLabels.length > 0) {
          displayName = `${displayName} (${chosenLabels.join(', ')})`;
        }
      }

      // Accumulate recipe ingredient requirements
      if (Array.isArray(dbItem.recipes)) {
        for (const ing of dbItem.recipes) {
          const invId = String(ing.inventoryId || ing.inventory_id || '');
          const reqQty = Number(ing.qty || ing.qty_required || 0) * qty;
          if (invId && reqQty > 0) {
            requiredStock.set(invId, (requiredStock.get(invId) ?? 0) + reqQty);
          }
        }
      }

      subtotal += unitPrice * qty;
      verifiedItems.push({
        menu_item_id: itemId,
        name: displayName,
        price: unitPrice,
        qty,
      });
    }

    // M-07: Check accumulated ingredient requirements against current stock
    for (const [invId, needed] of requiredStock.entries()) {
      const inv = stockById.get(invId);
      if (inv && inv.stock < needed) {
        return new Response(
          JSON.stringify({
            error: `Insufficient stock for ingredient "${inv.name}" to fulfill this order.`,
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    subtotal = Math.round(subtotal * 100) / 100;

    // S-06 & M-03: Server-side coupon validation and atomic consumption
    let discountAmount = 0;
    let appliedCouponCode: string | null = null;
    const rawCoupon = String(body.coupon_code || body.couponCode || '').trim().toUpperCase();

    if (rawCoupon) {
      const { data: coupon, error: couponErr } = await adminClient
        .from('coupons')
        .select('*')
        .eq('code', rawCoupon)
        .maybeSingle();

      if (couponErr || !coupon || !coupon.active || coupon.used) {
        return new Response(
          JSON.stringify({ error: 'Invalid or already-used coupon code.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
        return new Response(
          JSON.stringify({ error: 'This coupon has expired.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (coupon.assigned_to) {
        if (!user || coupon.assigned_to !== user.id) {
          return new Response(
            JSON.stringify({ error: 'This coupon is assigned to a specific account. Please sign in.' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      if (coupon.max_uses !== null && Number(coupon.used_count) >= Number(coupon.max_uses)) {
        return new Response(
          JSON.stringify({ error: 'This coupon has reached its maximum redemption limit.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // M-03: Clamp discount percent between 0 and 100
      const clampedPercent = Math.min(100, Math.max(0, Number(coupon.discount_percent) || 0));
      discountAmount = Math.round((subtotal * clampedPercent) / 100);
      appliedCouponCode = rawCoupon;

      const nextUsedCount = Number(coupon.used_count || 0) + 1;
      const markUsed = Boolean(coupon.single_use) || (coupon.max_uses !== null && nextUsedCount >= Number(coupon.max_uses));

      const { error: consumeErr } = await adminClient
        .from('coupons')
        .update({
          used_count: nextUsedCount,
          used: markUsed,
          active: markUsed ? false : coupon.active,
          updated_at: new Date().toISOString(),
        })
        .eq('code', rawCoupon)
        .eq('used', false);

      if (consumeErr) {
        return new Response(
          JSON.stringify({ error: 'Could not redeem coupon. Please try again.' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // M-01 Option B: Optional loyalty points redemption from profiles.loyalty_points
    let loyaltyRedeemPoints = Math.max(0, Math.floor(Number(body.loyalty_redeem_points || 0)));
    let loyaltyDiscount = 0;

    if (loyaltyRedeemPoints > 0) {
      if (!user) {
        return new Response(
          JSON.stringify({ error: 'Please sign in to redeem loyalty points.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: profile } = await adminClient
        .from('profiles')
        .select('loyalty_points')
        .eq('id', user.id)
        .maybeSingle();

      const availablePoints = Number(profile?.loyalty_points || 0);
      if (loyaltyRedeemPoints > availablePoints) {
        return new Response(
          JSON.stringify({ error: 'Insufficient loyalty points balance.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const maxRedeemable = Math.max(0, subtotal - discountAmount);
      loyaltyDiscount = Math.min(loyaltyRedeemPoints, maxRedeemable);
      loyaltyRedeemPoints = Math.floor(loyaltyDiscount);

      if (loyaltyRedeemPoints > 0) {
        await adminClient
          .from('profiles')
          .update({
            loyalty_points: availablePoints - loyaltyRedeemPoints,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);
      }
    }

    const total = Math.max(0, Math.round((subtotal - discountAmount - loyaltyDiscount) * 100) / 100);

    // M-02: Enforce minimum delivery order on post-discount total (consistent across Website & POS)
    if (orderType === 'DELIVERY' && total < MIN_DELIVERY_ORDER) {
      return new Response(
        JSON.stringify({
          error: `Minimum order for delivery is Rs. ${MIN_DELIVERY_ORDER} after discounts (current total: Rs. ${total}).`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const { data: insertedOrder, error: orderErr } = await adminClient
      .from('online_orders')
      .insert({
        id: orderId,
        customer_id: user ? user.id : null,
        customer: {
          name: customerName,
          phone: customerPhone,
          address: customerAddress,
        },
        items: verifiedItems,
        subtotal,
        discount_amount: discountAmount,
        loyalty_redeem_points: loyaltyRedeemPoints,
        loyalty_discount: loyaltyDiscount,
        coupon_code: appliedCouponCode,
        total,
        order_type: orderType,
        status: 'PENDING',
        source: 'website',
        note: String(body.note || '').trim(),
      })
      .select('*')
      .single();

    if (orderErr || !insertedOrder) {
      return new Response(
        JSON.stringify({ error: orderErr?.message || 'Failed to create order.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Insert normalized line items into online_order_items
    const lineRows = verifiedItems.map((it) => ({
      order_id: orderId,
      menu_item_id: it.menu_item_id,
      name: it.name,
      price: it.price,
      qty: it.qty,
    }));
    await adminClient.from('online_order_items').insert(lineRows);

    return new Response(
      JSON.stringify({ order: insertedOrder }),
      { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
