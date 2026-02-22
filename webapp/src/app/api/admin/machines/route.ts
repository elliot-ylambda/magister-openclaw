import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role via service client (bypasses RLS)
  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { action?: string; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, user_id } = body;

  if (!action || !user_id) {
    return NextResponse.json({ error: 'Missing action or user_id' }, { status: 400 });
  }

  if (action !== 'restart' && action !== 'suspend') {
    return NextResponse.json({ error: 'Invalid action. Use "restart" or "suspend".' }, { status: 400 });
  }

  if (!UUID_RE.test(user_id)) {
    return NextResponse.json({ error: 'Invalid user_id format' }, { status: 400 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  if (action === 'restart') {
    const { data: subscription } = await serviceClient
      .from('subscriptions')
      .select('plan')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    const res = await fetch(`${GATEWAY_URL}/api/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GATEWAY_API_KEY}`,
      },
      body: JSON.stringify({ user_id, plan: subscription?.plan ?? 'cmo' }),
    });

    if (!res.ok) {
      console.error(`[admin/machines] Gateway restart failed for user ${user_id}:`, await res.text());
      return NextResponse.json({ error: 'Failed to restart machine' }, { status: 502 });
    }

    return NextResponse.json({ success: true, action: 'restart' });
  }

  // action === 'suspend'
  const res = await fetch(`${GATEWAY_URL}/api/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id }),
  });

  if (!res.ok) {
    console.error(`[admin/machines] Gateway suspend failed for user ${user_id}:`, await res.text());
    return NextResponse.json({ error: 'Failed to suspend machine' }, { status: 502 });
  }

  return NextResponse.json({ success: true, action: 'suspend' });
}
