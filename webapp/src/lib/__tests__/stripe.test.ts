import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      webhooks = {};
      constructor() {}
    },
  };
});

describe('stripe utilities', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_CMO_PRICE_ID = 'price_cmo';
    process.env.STRIPE_CMO_PLUS_PRICE_ID = 'price_cmo_plus';
  });

  it('getStripe returns a Stripe instance', async () => {
    const { getStripe } = await import('../stripe');
    const stripe = getStripe();
    expect(stripe).toBeDefined();
  });

  it('getStripe returns singleton', async () => {
    const { getStripe } = await import('../stripe');
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
  });

  it('planFromPriceId returns cmo for CMO price', async () => {
    const { planFromPriceId } = await import('../stripe');
    expect(planFromPriceId('price_cmo')).toBe('cmo');
  });

  it('planFromPriceId returns cmo_plus for CMO+ price', async () => {
    const { planFromPriceId } = await import('../stripe');
    expect(planFromPriceId('price_cmo_plus')).toBe('cmo_plus');
  });

  it('planFromPriceId defaults to cmo for unknown price', async () => {
    const { planFromPriceId } = await import('../stripe');
    expect(planFromPriceId('price_unknown')).toBe('cmo');
  });

  it('priceIdFromPlan returns correct price IDs', async () => {
    const { priceIdFromPlan } = await import('../stripe');
    expect(priceIdFromPlan('cmo')).toBe('price_cmo');
    expect(priceIdFromPlan('cmo_plus')).toBe('price_cmo_plus');
  });
});
