import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const RESERVED_PREFIXES = ['GATEWAY_', 'SLACK_'];

function hasReservedPrefix(key: string) {
  return RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

async function verifyAdmin() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return null;

  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') return null;
  return serviceClient;
}

export async function GET(request: Request) {
  const serviceClient = await verifyAdmin();
  if (!serviceClient) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('user_id');

  const { data: secrets, error } = await serviceClient
    .from('global_secrets')
    .select('*')
    .order('key');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let overrides: Record<string, unknown>[] = [];
  if (userId) {
    const { data } = await serviceClient
      .from('user_secret_overrides')
      .select('*')
      .eq('user_id', userId);
    overrides = data ?? [];
  }

  return NextResponse.json({ secrets: secrets ?? [], overrides });
}

type Action = 'upsert_global' | 'delete_global' | 'upsert_override' | 'delete_override';

export async function POST(request: Request) {
  const serviceClient = await verifyAdmin();
  if (!serviceClient) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = body.action as Action | undefined;
  if (!action) {
    return NextResponse.json({ error: 'Missing action' }, { status: 400 });
  }

  switch (action) {
    case 'upsert_global': {
      const { key, value, description, category, is_sensitive } = body as {
        key?: string; value?: string; description?: string;
        category?: string; is_sensitive?: boolean;
      };
      if (!key || value === undefined) {
        return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
      }
      if (hasReservedPrefix(key)) {
        return NextResponse.json(
          { error: `Key cannot start with reserved prefix: ${RESERVED_PREFIXES.join(', ')}` },
          { status: 400 },
        );
      }
      const { error } = await serviceClient
        .from('global_secrets')
        .upsert(
          {
            key,
            value: value as string,
            description: description ?? '',
            category: category ?? 'general',
            is_sensitive: is_sensitive ?? true,
          },
          { onConflict: 'key' },
        );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    case 'delete_global': {
      const { key } = body as { key?: string };
      if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });
      // Also delete any user overrides for this key
      await serviceClient.from('user_secret_overrides').delete().eq('secret_key', key);
      const { error } = await serviceClient.from('global_secrets').delete().eq('key', key);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    case 'upsert_override': {
      const { user_id, secret_key, value } = body as {
        user_id?: string; secret_key?: string; value?: string;
      };
      if (!user_id || !secret_key || value === undefined) {
        return NextResponse.json({ error: 'Missing user_id, secret_key, or value' }, { status: 400 });
      }
      const { error } = await serviceClient
        .from('user_secret_overrides')
        .upsert(
          { user_id, secret_key, value: value as string },
          { onConflict: 'user_id,secret_key' },
        );
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    case 'delete_override': {
      const { user_id, secret_key } = body as { user_id?: string; secret_key?: string };
      if (!user_id || !secret_key) {
        return NextResponse.json({ error: 'Missing user_id or secret_key' }, { status: 400 });
      }
      const { error } = await serviceClient
        .from('user_secret_overrides')
        .delete()
        .eq('user_id', user_id)
        .eq('secret_key', secret_key);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }
}
