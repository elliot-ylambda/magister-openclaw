import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  let body: { user_id?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const res = await fetch(`${GATEWAY_URL}/api/admin/secrets/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[admin/secrets/push] Gateway push failed:', text);
    return NextResponse.json({ error: 'Failed to push secrets' }, { status: 502 });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
