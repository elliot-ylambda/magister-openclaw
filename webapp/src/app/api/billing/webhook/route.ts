import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  }
  return _stripe;
}

export async function POST(req: NextRequest) {
  const GATEWAY_URL = process.env.GATEWAY_URL!;
  const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY!;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      if (!userId) break;

      const plan = session.metadata?.plan ?? "cmo";

      const res = await fetch(`${GATEWAY_URL}/api/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId, plan }),
      });

      if (!res.ok) {
        console.error("[billing] Provisioning failed:", await res.text());
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const userId = subscription.metadata?.user_id;
      if (!userId) break;

      const res = await fetch(`${GATEWAY_URL}/api/destroy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GATEWAY_API_KEY}`,
        },
        body: JSON.stringify({ user_id: userId }),
      });

      if (!res.ok) {
        console.error("[billing] Destroy failed:", await res.text());
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
