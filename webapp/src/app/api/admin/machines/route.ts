import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Action = 'stop' | 'start' | 'restart' | 'reset' | 'destroy';
const VALID_ACTIONS: Action[] = ['stop', 'start', 'restart', 'reset', 'destroy'];

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

  if (!VALID_ACTIONS.includes(action as Action)) {
    return NextResponse.json(
      { error: `Invalid action. Use one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 }
    );
  }

  if (!UUID_RE.test(user_id)) {
    return NextResponse.json({ error: 'Invalid user_id format' }, { status: 400 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  const gatewayHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${GATEWAY_API_KEY}`,
  };

  // Stop / Start / Restart — call new machine control endpoints
  if (action === 'stop' || action === 'start' || action === 'restart') {
    const res = await fetch(`${GATEWAY_URL}/api/machine/${action}`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({ user_id }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[admin/machines] Gateway ${action} failed for user ${user_id}:`, text);
      return NextResponse.json({ error: `Failed to ${action} machine` }, { status: 502 });
    }

    return NextResponse.json({ success: true, action });
  }

  // Reset — destroy + re-provision
  if (action === 'reset') {
    const { data: subscription } = await serviceClient
      .from('subscriptions')
      .select('plan')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    const destroyRes = await fetch(`${GATEWAY_URL}/api/destroy`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({ user_id }),
    });

    if (!destroyRes.ok) {
      const text = await destroyRes.text();
      console.error(`[admin/machines] Gateway destroy (reset) failed for user ${user_id}:`, text);
      return NextResponse.json({ error: 'Failed to destroy machine for reset' }, { status: 502 });
    }

    const provisionRes = await fetch(`${GATEWAY_URL}/api/provision`, {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({ user_id, plan: subscription?.plan ?? 'cmo' }),
    });

    if (!provisionRes.ok) {
      const text = await provisionRes.text();
      console.error(`[admin/machines] Gateway provision (reset) failed for user ${user_id}:`, text);
      return NextResponse.json({ error: 'Failed to re-provision machine after reset' }, { status: 502 });
    }

    return NextResponse.json({ success: true, action: 'reset' });
  }

  // Destroy — permanent delete
  const res = await fetch(`${GATEWAY_URL}/api/destroy`, {
    method: 'POST',
    headers: gatewayHeaders,
    body: JSON.stringify({ user_id }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[admin/machines] Gateway destroy failed for user ${user_id}:`, text);
    return NextResponse.json({ error: 'Failed to destroy machine' }, { status: 502 });
  }

  return NextResponse.json({ success: true, action: 'destroy' });
}
