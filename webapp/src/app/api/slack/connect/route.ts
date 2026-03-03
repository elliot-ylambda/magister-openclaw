import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
  const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? '';
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3020';

  // Build HMAC-signed state: timestamp.user_id.signature
  const ts = Date.now().toString();
  const sig = createHmac('sha256', GATEWAY_API_KEY)
    .update(`${ts}.${user.id}`)
    .digest('hex');
  const state = `${ts}.${user.id}.${sig}`;

  const redirectUri = `${APP_URL}/api/slack/callback`;
  const scopes = [
    'app_mentions:read',
    'channels:history',
    'channels:read',
    'chat:write',
    'files:read',
    'files:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'reactions:read',
    'reactions:write',
    'users:read',
  ].join(',');

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: scopes,
    redirect_uri: redirectUri,
    state,
  });

  return NextResponse.json({
    url: `https://slack.com/oauth/v2/authorize?${params.toString()}`,
  });
}
