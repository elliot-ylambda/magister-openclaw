import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe, planFromPriceId } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const GATEWAY_URL = process.env.GATEWAY_URL!;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY!;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const supabase = createServiceClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      if (!userId) break;

      // Persist stripe_customer_id to profiles
      if (session.customer) {
        await supabase
          .from('profiles')
          .update({ stripe_customer_id: session.customer as string })
          .eq('id', userId);
      }

      const plan = session.metadata?.plan ?? 'cmo';

      const res = await fetch(`${GATEWAY_URL}/api/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId, plan }),
      });

      if (!res.ok) {
        console.error('[billing] Provisioning failed:', await res.text());
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      if (!userId) break;

      const item = subscription.items.data[0];
      const priceId = item?.price?.id;
      const plan = priceId ? planFromPriceId(priceId) : 'cmo';

      // In Stripe SDK v20, current_period_start/end moved to SubscriptionItem
      const periodStart = item?.current_period_start;
      const periodEnd = item?.current_period_end;

      await supabase.from('subscriptions').upsert(
        {
          user_id: userId,
          stripe_subscription_id: subscription.id,
          stripe_price_id: priceId ?? '',
          plan,
          status: subscription.status,
          current_period_start: periodStart
            ? new Date(periodStart * 1000).toISOString()
            : new Date().toISOString(),
          current_period_end: periodEnd
            ? new Date(periodEnd * 1000).toISOString()
            : new Date().toISOString(),
          cancel_at: subscription.cancel_at
            ? new Date(subscription.cancel_at * 1000).toISOString()
            : null,
        },
        { onConflict: 'stripe_subscription_id' }
      );
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      if (!userId) break;

      await supabase
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('stripe_subscription_id', subscription.id);

      const res = await fetch(`${GATEWAY_URL}/api/destroy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });

      if (!res.ok) {
        console.error('[billing] Destroy failed:', await res.text());
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      // In Stripe SDK v20, subscription moved to invoice.parent.subscription_details
      const parentSub = invoice.parent?.subscription_details?.subscription;
      const subscriptionId =
        typeof parentSub === 'string'
          ? parentSub
          : parentSub?.id;
      if (!subscriptionId) break;

      await supabase
        .from('subscriptions')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', subscriptionId);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
