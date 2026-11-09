import { createClient } from 'npm:@supabase/supabase-js@2';

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowedEnv = Deno.env.get('ALLOWED_ORIGINS');

  // Explicit allowed origins: configurable via ALLOWED_ORIGINS env var
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
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, idempotency-key, x-idempotency-key',
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

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server configuration missing.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Phase 2.5: Enforce request size limit (max 512KB)
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > 512 * 1024) {
      return new Response(
        JSON.stringify({ error: 'Payload too large.' }),
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Phase 2.5: Authentication verification with strict Bearer token handling
    const authHeader = req.headers.get('Authorization');
    let user: { id: string; email?: string; email_confirmed_at?: string } | null = null;

    if (authHeader && authHeader.trim().toLowerCase().startsWith('bearer ')) {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: authError } = await userClient.auth.getUser();
      if (authError || !userData?.user) {
        // Never silently downgrade an invalid/expired authenticated request into a guest request
        return new Response(
          JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      user = userData.user;
    }

    // Phase 2.4: Email verification check for authenticated users
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
            error: 'Please verify your email before placing an order.',
            code: 'EMAIL_NOT_VERIFIED',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new Response(
        JSON.stringify({ error: 'Malformed JSON payload.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Phase 3.5 & P1: Mandatory Idempotency Key Validation
    const idempotencyKey = String(
      req.headers.get('Idempotency-Key') ||
      req.headers.get('X-Idempotency-Key') ||
      body.idempotency_key ||
      body.idempotencyKey ||
      ''
    ).trim();

    const IDEMP_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
    if (!idempotencyKey || !IDEMP_REGEX.test(idempotencyKey)) {
      return new Response(
        JSON.stringify({
          error: 'Missing or invalid Idempotency-Key. A unique key (16 to 128 characters: letters, digits, _, -) is required.',
          code: 'INVALID_IDEMPOTENCY_KEY',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Order must contain at least one item.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderType = String(body.order_type || body.orderType || 'DELIVERY').toUpperCase();
    const customer = {
      name: String(body.customer?.name || '').trim(),
      phone: String(body.customer?.phone || '').trim(),
      address: String(body.customer?.address || '').trim(),
    };

    const couponCode = String(body.coupon_code || body.couponCode || '').trim();
    const loyaltyRedeemPoints = Math.max(0, Math.floor(Number(body.loyalty_redeem_points || body.loyaltyRedeemPoints || 0)));
    const note = String(body.note || '').trim();

    // Phase 3.1: Execute checkout inside PostgreSQL trusted atomic transaction
    const { data: result, error: rpcErr } = await adminClient.rpc(
      'process_online_order_checkout',
      {
        p_idempotency_key: idempotencyKey || null,
        p_customer_id: user ? user.id : null,
        p_customer: customer,
        p_items: rawItems,
        p_order_type: orderType,
        p_coupon_code: couponCode || null,
        p_loyalty_redeem_points: loyaltyRedeemPoints,
        p_note: note,
      }
    );

    if (rpcErr) {
      return new Response(
        JSON.stringify({ error: rpcErr.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const order = result?.order;
    const isReplayed = Boolean(result?.replayed);

    return new Response(
      JSON.stringify({
        order,
        idempotent_replayed: isReplayed,
      }),
      {
        status: isReplayed ? 200 : 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
