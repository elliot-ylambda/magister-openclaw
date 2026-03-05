import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const VALID_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'gemini'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { provider } = body as { provider?: string };

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  const { error } = await serviceClient
    .from('user_api_keys')
    .update({ status: 'revoked' })
    .eq('user_id', user.id)
    .eq('provider', provider);

  if (error) {
    return NextResponse.json({ error: 'Failed to remove key' }, { status: 500 });
  }

  return NextResponse.json({ status: 'removed', provider });
}
