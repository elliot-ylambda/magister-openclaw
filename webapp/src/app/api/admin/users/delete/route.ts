import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role via service client (bypasses RLS)
  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { user_id } = body;

  if (!user_id) {
    return NextResponse.json({ error: 'Missing user_id' }, { status: 400 });
  }

  if (!UUID_RE.test(user_id)) {
    return NextResponse.json({ error: 'Invalid user_id format' }, { status: 400 });
  }

  if (user_id === user.id) {
    return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
  }

  // Verify target user exists
  const { data: targetProfile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('id', user_id)
    .single();

  if (!targetProfile) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const GATEWAY_URL = process.env.GATEWAY_URL;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;

  if (!GATEWAY_URL || !GATEWAY_API_KEY) {
    return NextResponse.json({ error: 'Gateway not configured' }, { status: 500 });
  }

  // Step 1: Destroy Fly machine (idempotent, safe if no machine exists)
  const destroyRes = await fetch(`${GATEWAY_URL}/api/destroy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({ user_id }),
  });

  if (!destroyRes.ok) {
    // Non-fatal — machine may already be destroyed or never provisioned
    const text = await destroyRes.text();
    console.warn(`[admin/users/delete] Machine destroy returned ${destroyRes.status} for user ${user_id} (continuing):`, text);
  }

  // Step 2: Cancel Stripe subscription if active
  const { data: subscription } = await serviceClient
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', user_id)
    .eq('status', 'active')
    .single();

  if (subscription?.stripe_subscription_id) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
    } catch (err) {
      console.error(`[admin/users/delete] Failed to cancel Stripe subscription for user ${user_id}:`, err);
      return NextResponse.json({ error: 'Failed to cancel Stripe subscription' }, { status: 502 });
    }
  }

  // Step 3: Remove usage_events (no CASCADE by design — preserves billing history,
  // but blocks auth user deletion via FK constraint)
  const { error: usageError } = await serviceClient
    .from('usage_events')
    .delete()
    .eq('user_id', user_id);

  if (usageError) {
    console.error(`[admin/users/delete] Failed to delete usage_events for user ${user_id}:`, usageError);
    return NextResponse.json({ error: 'Failed to delete usage events' }, { status: 500 });
  }

  // Step 4: Delete Supabase auth user (cascades to profiles, subscriptions, etc.)
  const { error: deleteError } = await serviceClient.auth.admin.deleteUser(user_id);

  if (deleteError) {
    console.error(`[admin/users/delete] Failed to delete auth user ${user_id}:`, deleteError);
    return NextResponse.json({ error: 'Failed to delete user from auth' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
