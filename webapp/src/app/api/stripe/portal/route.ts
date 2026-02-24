import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceClient = createServiceClient();
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single();

  if (!profile?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
  }

  let returnPath = '/dashboard';
  try {
    const body = await request.json();
    const ALLOWED = ['/dashboard', '/settings', '/chat', '/pricing'];
    if (body?.returnUrl && ALLOWED.includes(body.returnUrl)) {
      returnPath = body.returnUrl;
    }
  } catch {
    // No body or invalid JSON — use default
  }

  try {
    const stripe = getStripe();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}${returnPath}`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal session error:', err);
    return NextResponse.json(
      { error: 'Failed to create portal session' },
      { status: 500 },
    );
  }
}
