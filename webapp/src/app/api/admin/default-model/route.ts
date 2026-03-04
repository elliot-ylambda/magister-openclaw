import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function GET() {
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

  const res = await fetch(`${GATEWAY_URL}/api/admin/default-model`, {
    headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'Failed to get default model' }, { status: 502 });
  }

  return NextResponse.json(await res.json());
}

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

  let body: { model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.model) {
    return NextResponse.json({ error: 'Missing model' }, { status: 400 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  const res = await fetch(`${GATEWAY_URL}/api/admin/default-model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ model: body.model }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[admin/default-model] Gateway failed:', text);
    return NextResponse.json({ error: 'Failed to update default model' }, { status: 502 });
  }

  return NextResponse.json(await res.json());
}
