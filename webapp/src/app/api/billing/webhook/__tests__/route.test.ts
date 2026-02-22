import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mock Supabase service client ---
const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn().mockReturnValue(mockServiceClient),
}));

// --- Mock Stripe ---
const mockConstructEvent = vi.fn();

vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn().mockReturnValue({
    webhooks: { constructEvent: mockConstructEvent },
  }),
  planFromPriceId: vi.fn((priceId: string) =>
    priceId === 'price_cmo_plus' ? 'cmo_plus' : 'cmo'
  ),
}));

// --- Mock fetch for Gateway calls ---
let mockFetch: ReturnType<typeof vi.fn>;

function makeRequest(sig?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sig) headers['stripe-signature'] = sig;
  return new NextRequest('http://localhost/api/billing/webhook', {
    method: 'POST',
    headers,
    body: 'raw-body',
  });
}

function setupChainMock() {
  const chain = {
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe('POST /api/billing/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', mockFetch);
    process.env.GATEWAY_URL = 'http://gateway.test';
    process.env.GATEWAY_API_KEY = 'test-key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('returns 400 without stripe-signature header', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Missing signature');
  });

  it('returns 400 with invalid signature', async () => {
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });

    const { POST } = await import('../route');
    const res = await POST(makeRequest('invalid_sig'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid signature');
  });

  describe('checkout.session.completed', () => {
    it('updates profiles.stripe_customer_id and calls Gateway provision', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: 'user-123',
            customer: 'cus_abc',
            metadata: { plan: 'cmo' },
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFrom).toHaveBeenCalledWith('profiles');
      expect(chain.update).toHaveBeenCalledWith({ stripe_customer_id: 'cus_abc' });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://gateway.test/api/provision',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ user_id: 'user-123', plan: 'cmo' }),
        })
      );
    });

    it('handles missing client_reference_id gracefully', async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: null,
            customer: 'cus_abc',
            metadata: {},
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('customer.subscription.created', () => {
    it('upserts subscription with correct plan, status, and period dates', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_123',
            metadata: { user_id: 'user-456' },
            status: 'active',
            items: { data: [{ price: { id: 'price_cmo_plus' }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
            cancel_at: null,
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFrom).toHaveBeenCalledWith('subscriptions');
      expect(chain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-456',
          stripe_subscription_id: 'sub_123',
          stripe_price_id: 'price_cmo_plus',
          plan: 'cmo_plus',
          status: 'active',
        }),
        { onConflict: 'stripe_subscription_id' }
      );
    });
  });

  describe('customer.subscription.updated', () => {
    it('upserts updated subscription', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            metadata: { user_id: 'user-456' },
            status: 'active',
            items: { data: [{ price: { id: 'price_cmo' }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
            cancel_at: 1703000000,
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(chain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: 'cmo',
          cancel_at: new Date(1703000000 * 1000).toISOString(),
        }),
        { onConflict: 'stripe_subscription_id' }
      );
    });

    it('handles missing metadata gracefully', async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            metadata: {},
            status: 'active',
            items: { data: [{ price: { id: 'price_cmo' }, current_period_start: 1700000000, current_period_end: 1702592000 }] },
            cancel_at: null,
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      // Should return 200 without crashing, but skip the upsert
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.received).toBe(true);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('updates status to canceled and calls Gateway destroy', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_789',
            metadata: { user_id: 'user-789' },
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFrom).toHaveBeenCalledWith('subscriptions');
      expect(chain.update).toHaveBeenCalledWith({ status: 'canceled' });
      expect(chain.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_789');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://gateway.test/api/destroy',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ user_id: 'user-789' }),
        })
      );
    });
  });

  describe('invoice.payment_failed', () => {
    it('updates subscription status to past_due (string subscription)', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'invoice.payment_failed',
        data: {
          object: {
            parent: {
              subscription_details: { subscription: 'sub_failed_123' },
            },
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFrom).toHaveBeenCalledWith('subscriptions');
      expect(chain.update).toHaveBeenCalledWith({ status: 'past_due' });
      expect(chain.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_failed_123');
    });

    it('updates subscription status to past_due (expanded subscription object)', async () => {
      const chain = setupChainMock();
      mockConstructEvent.mockReturnValueOnce({
        type: 'invoice.payment_failed',
        data: {
          object: {
            parent: {
              subscription_details: { subscription: { id: 'sub_failed_456' } },
            },
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(chain.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_failed_456');
    });

    it('handles null subscription gracefully', async () => {
      mockConstructEvent.mockReturnValueOnce({
        type: 'invoice.payment_failed',
        data: {
          object: {
            parent: null,
          },
        },
      });

      const { POST } = await import('../route');
      const res = await POST(makeRequest('valid_sig'));

      expect(res.status).toBe(200);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  it('returns { received: true } for all valid events', async () => {
    mockConstructEvent.mockReturnValueOnce({
      type: 'some.unknown.event',
      data: { object: {} },
    });

    const { POST } = await import('../route');
    const res = await POST(makeRequest('valid_sig'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.received).toBe(true);
  });
});
