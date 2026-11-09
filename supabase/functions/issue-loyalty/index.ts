import { createClient } from 'npm:@supabase/supabase-js@2';

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowedEnv = Deno.env.get('ALLOWED_ORIGINS');

  const allowedList = (allowedEnv && allowedEnv.trim())
    ? allowedEnv.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean)
    : [
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
      ];

  let allowOrigin = 'null';
  if (origin && allowedList.includes(origin.toLowerCase())) {
    allowOrigin = origin;
  } else if (!origin && allowedList.length > 0) {
    allowOrigin = allowedList[0];
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authentication required.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired session.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Only authorized staff (OWNER, MANAGER, CASHIER) may issue loyalty points
    const { data: callerProfile } = await adminClient
      .from('profiles')
      .select('role, active')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (
      !callerProfile ||
      !callerProfile.active ||
      !['OWNER', 'MANAGER', 'CASHIER'].includes(String(callerProfile.role))
    ) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: Only authorized staff can issue order loyalty rewards.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new Response(
        JSON.stringify({ error: 'Malformed JSON payload.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderId = String(body.orderId || body.order_id || '').trim();
    if (!orderId) {
      return new Response(
        JSON.stringify({ error: 'orderId is required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: order, error: orderErr } = await adminClient
      .from('online_orders')
      .select('id, customer_id, customer, total, status, loyalty_issued')
      .eq('id', orderId)
      .maybeSingle();

    if (orderErr || !order) {
      return new Response(
        JSON.stringify({ error: 'Order not found.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (order.loyalty_issued) {
      return new Response(
        JSON.stringify({ alreadyIssued: true, message: 'Loyalty already awarded for this order.' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!order.customer_id) {
      return new Response(
        JSON.stringify({ skipped: true, message: 'Order has no linked customer profile.' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: profile, error: profErr } = await adminClient
      .from('profiles')
      .select('id, order_count, loyalty_points, processed_order_ids')
      .eq('id', order.customer_id)
      .maybeSingle();

    if (profErr || !profile) {
      return new Response(
        JSON.stringify({ error: 'Customer profile not found.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const processedIds: string[] = Array.isArray(profile.processed_order_ids)
      ? profile.processed_order_ids
      : [];

    if (processedIds.includes(orderId)) {
      await adminClient.from('online_orders').update({ loyalty_issued: true }).eq('id', orderId);
      return new Response(
        JSON.stringify({ alreadyIssued: true, orderCount: profile.order_count, loyaltyPoints: profile.loyalty_points }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const earnedPoints = Math.max(0, Math.floor(Number(order.total || 0) / 100));
    const newOrderCount = Number(profile.order_count || 0) + 1;
    const newLoyaltyPoints = Number(profile.loyalty_points || 0) + earnedPoints;
    const updatedProcessedIds = [...processedIds.slice(-199), orderId];

    const { error: updateProfErr } = await adminClient
      .from('profiles')
      .update({
        order_count: newOrderCount,
        loyalty_points: newLoyaltyPoints,
        processed_order_ids: updatedProcessedIds,
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id);

    if (updateProfErr) {
      return new Response(
        JSON.stringify({ error: 'Failed to update customer loyalty counters.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Record in loyalty transactions ledger
    if (earnedPoints > 0) {
      await adminClient.from('loyalty_transactions').insert({
        profile_id: profile.id,
        points_change: earnedPoints,
        new_balance: newLoyaltyPoints,
        transaction_type: 'EARN_ORDER',
        reference_id: orderId,
        description: `Earned ${earnedPoints} points on order #${orderId}`,
      });
    }

    await adminClient
      .from('online_orders')
      .update({ loyalty_issued: true, updated_at: new Date().toISOString() })
      .eq('id', orderId);

    // Keep POS CRM customers table in sync
    const customerPhone = String(order.customer?.phone || '').trim();
    if (customerPhone) {
      await adminClient
        .from('customers')
        .update({
          points: newLoyaltyPoints,
          profile_id: profile.id,
          updated_at: new Date().toISOString(),
        })
        .eq('phone', customerPhone);
    }

    // Every 10th completed order mints a single-use 10%-off loyalty coupon
    let mintedCouponCode: string | null = null;
    if (newOrderCount > 0 && newOrderCount % 10 === 0) {
      const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
      mintedCouponCode = `LOYAL${randomSuffix}`;
      await adminClient.from('coupons').insert({
        code: mintedCouponCode,
        discount_percent: 10,
        type: 'loyalty_10th_order',
        single_use: true,
        assigned_to: profile.id,
        active: true,
        used: false,
        used_count: 0,
        max_uses: 1,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        orderCount: newOrderCount,
        earnedPoints,
        loyaltyPoints: newLoyaltyPoints,
        mintedCouponCode,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
