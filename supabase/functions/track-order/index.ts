import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function normalizeDigits(phone: string): string {
  return String(phone || '').replace(/\D/g, '');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const body = await req.json();
    const orderId = String(body.orderId || body.order_id || '').trim();
    const phone = normalizeDigits(body.phone || '');

    if (!orderId || phone.length < 7) {
      return new Response(
        JSON.stringify({ error: 'Both Order ID and customer phone number are required to track an order.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: order, error } = await adminClient
      .from('online_orders')
      .select('id, status, order_type, total, items, customer, rejection_reason, created_at, accepted_at, preparing_at, out_for_delivery_at, completed_at, rejected_at')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !order) {
      return new Response(
        JSON.stringify({ error: 'Order not found. Please check your Order ID and phone number.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const orderPhone = normalizeDigits(order.customer?.phone || '');
    const suffixMatch = orderPhone.length >= 7 && orderPhone.slice(-7) === phone.slice(-7);
    if (!suffixMatch) {
      return new Response(
        JSON.stringify({ error: 'Order not found. Please check your Order ID and phone number.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // S-03: Return only non-sensitive status & summary fields, never full customer address/PII
    return new Response(
      JSON.stringify({
        order: {
          id: order.id,
          status: order.status,
          order_type: order.order_type,
          total: order.total,
          items: Array.isArray(order.items)
            ? order.items.map((it: { name: string; qty: number; price: number }) => ({
                name: it.name,
                qty: it.qty,
                price: it.price,
              }))
            : [],
          rejection_reason: order.rejection_reason,
          created_at: order.created_at,
          accepted_at: order.accepted_at,
          preparing_at: order.preparing_at,
          out_for_delivery_at: order.out_for_delivery_at,
          completed_at: order.completed_at,
          rejected_at: order.rejected_at,
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
