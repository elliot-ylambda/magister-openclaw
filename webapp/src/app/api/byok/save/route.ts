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
  const { provider, apiKey } = body as { provider?: string; apiKey?: string };

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 10) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 400 });
  }

  const keySuffix = apiKey.slice(-4);
  const serviceClient = createServiceClient();

  const { error } = await serviceClient
    .from('user_api_keys')
    .upsert(
      {
        user_id: user.id,
        provider,
        api_key: apiKey,
        key_suffix: keySuffix,
        status: 'active',
      },
      { onConflict: 'user_id,provider' }
    );

  if (error) {
    return NextResponse.json({ error: 'Failed to save key' }, { status: 500 });
  }

  return NextResponse.json({ status: 'saved', provider, keySuffix });
}
