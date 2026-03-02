import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  }
  return _stripe;
}

export function planFromPriceId(priceId: string): 'cmo' | 'cmo_plus' {
  if (priceId === process.env.STRIPE_CMO_PLUS_PRICE_ID) return 'cmo_plus';
  return 'cmo';
}

export function priceIdFromPlan(plan: string): string {
  if (plan === 'cmo_plus') return process.env.STRIPE_CMO_PLUS_PRICE_ID!;
  return process.env.STRIPE_CMO_PRICE_ID!;
}
