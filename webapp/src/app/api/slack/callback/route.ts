import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function verifyState(state: string, secret: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;

  const [ts, userId, sig] = parts;
  const age = Date.now() - Number(ts);
  if (isNaN(age) || age < 0 || age > STATE_MAX_AGE_MS) return null;

  const expected = createHmac('sha256', secret)
    .update(`${ts}.${userId}`)
    .digest('hex');

  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  return userId;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY ?? '';
  const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? '';
  const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? '';
  const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? '';
  const GATEWAY_URL = process.env.GATEWAY_URL ?? '';
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3020';

  if (error) {
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=${error}`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=missing_params`);
  }

  // Verify CSRF state
  const stateUserId = verifyState(state, GATEWAY_API_KEY);
  if (!stateUserId) {
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=invalid_state`);
  }

  // Verify current user matches state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== stateUserId) {
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=unauthorized`);
  }

  // Exchange code for tokens
  const tokenResp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.ok) {
    console.error('[slack/callback] OAuth token exchange failed:', tokenData.error);
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=token_exchange`);
  }

  // Upsert slack_connections row
  const serviceClient = createServiceClient();
  const { error: dbError } = await serviceClient
    .from('slack_connections')
    .upsert(
      {
        user_id: user.id,
        team_id: tokenData.team?.id ?? '',
        team_name: tokenData.team?.name ?? '',
        bot_user_id: tokenData.bot_user_id ?? '',
        app_id: tokenData.app_id ?? '',
        bot_token: tokenData.access_token ?? '',
        scope: tokenData.scope ?? '',
        status: 'active',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,team_id' }
    );

  if (dbError) {
    console.error('[slack/callback] DB upsert failed:', dbError);
    return NextResponse.redirect(`${APP_URL}/settings?slack=error&reason=db_error`);
  }

  // Inject Slack secrets into user's Fly machine via Gateway
  if (GATEWAY_URL && GATEWAY_API_KEY) {
    try {
      const injectResp = await fetch(`${GATEWAY_URL}/api/slack/inject-secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({
          user_id: user.id,
          bot_token: tokenData.access_token,
          signing_secret: SLACK_SIGNING_SECRET,
        }),
      });

      if (!injectResp.ok) {
        console.error(
          '[slack/callback] Secret injection failed:',
          await injectResp.text()
        );
      }
    } catch (err) {
      console.error('[slack/callback] Secret injection error:', err);
    }
  }

  return NextResponse.redirect(`${APP_URL}/settings?slack=connected`);
}
