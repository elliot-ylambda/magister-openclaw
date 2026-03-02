import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  // Fetch user's plan for re-provisioning
  const serviceClient = createServiceClient();
  const { data: subscription } = await serviceClient
    .from('subscriptions')
    .select('plan')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .single();

  const plan = subscription?.plan ?? 'cmo';

  // Step 1: Destroy existing machine
  const destroyRes = await fetch(`${GATEWAY_URL}/api/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id: user.id }),
  });

  if (!destroyRes.ok) {
    const text = await destroyRes.text();
    console.error(`[machine/reset] Destroy failed for user ${user.id}:`, text);
    return NextResponse.json({ error: 'Failed to destroy machine' }, { status: 502 });
  }

  // Step 2: Re-provision
  const provisionRes = await fetch(`${GATEWAY_URL}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id: user.id, plan }),
  });

  if (!provisionRes.ok) {
    const text = await provisionRes.text();
    console.error(`[machine/reset] Provision failed for user ${user.id}:`, text);
    return NextResponse.json({ error: 'Failed to re-provision machine' }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
