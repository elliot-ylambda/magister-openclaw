import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { session }, error: authError } = await supabase.auth.getSession();
  if (authError || !session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (!gatewayUrl) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  const res = await fetch(`${gatewayUrl}/api/browser/token/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(
      { error: data.detail ?? 'Failed to generate token' },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}
