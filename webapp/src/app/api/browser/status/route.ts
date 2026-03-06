import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!gatewayUrl || !apiKey) {
    return NextResponse.json({ connected: false });
  }

  try {
    const res = await fetch(
      `${gatewayUrl}/api/browser/status?user_id=${encodeURIComponent(user.id)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    if (!res.ok) {
      return NextResponse.json({ connected: false });
    }
    const data = await res.json();
    return NextResponse.json({ connected: data.connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
