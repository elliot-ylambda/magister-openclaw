import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST() {
  const GATEWAY_URL = process.env.GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceClient = createServiceClient();
  const { data: subscription } = await serviceClient
    .from('subscriptions')
    .select('plan')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  const plan = subscription?.plan ?? 'cmo';

  const res = await fetch(`${GATEWAY_URL}/api/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id: user.id, plan }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[provision/retry] Provisioning failed for user ${user.id}:`, text);
    return NextResponse.json({ error: text }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
