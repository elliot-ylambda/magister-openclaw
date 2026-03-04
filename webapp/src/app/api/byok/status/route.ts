import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'gemini'] as const;

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: keys } = await supabase
    .from('user_api_keys_safe')
    .select('provider, key_suffix, status')
    .eq('user_id', user.id)
    .eq('status', 'active');

  const keyMap = new Map((keys ?? []).map((k) => [k.provider, k.key_suffix]));

  const providers = Object.fromEntries(
    PROVIDERS.map((p) => [
      p,
      {
        connected: keyMap.has(p),
        keySuffix: keyMap.get(p) ?? null,
      },
    ])
  );

  return NextResponse.json({ providers });
}
