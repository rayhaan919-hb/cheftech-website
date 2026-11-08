import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authentication required to validate or redeem coupons.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Invalid session.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const user = userData.user;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const code = String(body.code || '').trim().toUpperCase();
    const consume = Boolean(body.consume);

    if (!code) {
      return new Response(
        JSON.stringify({ error: 'Coupon code is required.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: coupon, error: couponErr } = await adminClient
      .from('coupons')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (couponErr || !coupon || !coupon.active || coupon.used) {
      return new Response(
        JSON.stringify({ error: 'Invalid or already-used coupon code.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
      return new Response(
        JSON.stringify({ error: 'This coupon has expired.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (coupon.assigned_to && coupon.assigned_to !== user.id) {
      return new Response(
        JSON.stringify({ error: 'This coupon is assigned to another customer.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (coupon.max_uses !== null && Number(coupon.used_count) >= Number(coupon.max_uses)) {
      return new Response(
        JSON.stringify({ error: 'This coupon has reached its usage limit.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // M-03: Clamp discount percent to 0..100
    const discountPercent = Math.min(100, Math.max(0, Number(coupon.discount_percent) || 0));

    if (consume) {
      const nextUsedCount = Number(coupon.used_count || 0) + 1;
      const markUsed = Boolean(coupon.single_use) || (coupon.max_uses !== null && nextUsedCount >= Number(coupon.max_uses));

      const { error: updateErr } = await adminClient
        .from('coupons')
        .update({
          used_count: nextUsedCount,
          used: markUsed,
          active: markUsed ? false : coupon.active,
          updated_at: new Date().toISOString(),
        })
        .eq('code', code)
        .eq('used', false);

      if (updateErr) {
        return new Response(
          JSON.stringify({ error: 'Failed to consume coupon.' }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({
        valid: true,
        consumed: consume,
        coupon: {
          code: coupon.code,
          discount_percent: discountPercent,
          type: coupon.type,
          single_use: coupon.single_use,
        },
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
