import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceClient = createServiceClient();

  // Get the active connection to find token + team_id
  const { data: connection } = await serviceClient
    .from('slack_connections')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!connection) {
    return NextResponse.json({ error: 'No active Slack connection' }, { status: 404 });
  }

  // 1. Mark as revoked in DB
  await serviceClient
    .from('slack_connections')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('id', connection.id);

  // 2. Remove Fly secrets via Gateway
  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
  if (GATEWAY_URL && GATEWAY_API_KEY) {
    try {
      await fetch(`${GATEWAY_URL}/api/slack/remove-secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: user.id }),
      });
    } catch (err) {
      console.error('[slack/disconnect] Remove secrets error:', err);
    }
  }

  // 3. Best-effort: revoke Slack token
  if (connection.bot_token) {
    try {
      await fetch('https://slack.com/api/auth.revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${connection.bot_token}`,
        },
      });
    } catch {
      // Best-effort — don't fail disconnect if Slack is unreachable
    }
  }

  return NextResponse.json({ success: true });
}
