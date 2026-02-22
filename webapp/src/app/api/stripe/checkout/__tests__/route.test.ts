import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockUser, createMockSupabaseClient } from '@/__tests__/mocks/supabase';

const mockSupabaseClient = createMockSupabaseClient({ user: createMockUser() });
const mockServiceClient = createMockSupabaseClient({
  queryData: { stripe_customer_id: null },
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseClient),
  createServiceClient: vi.fn().mockReturnValue(mockServiceClient),
}));

const mockStripe = {
  customers: {
    create: vi.fn().mockResolvedValue({ id: 'cus_new_123' }),
  },
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_123' }),
    },
  },
};

vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn().mockReturnValue(mockStripe),
  priceIdFromPlan: vi.fn((plan: string) =>
    plan === 'cmo_plus' ? 'price_cmo_plus' : 'price_cmo'
  ),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/stripe/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/stripe/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3020';

    // Reset to authenticated user
    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: createMockUser() },
      error: null,
    });

    // Reset to no existing customer
    mockServiceClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { stripe_customer_id: null },
            error: null,
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    });
  });

  it('returns 401 when user is not authenticated', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });

    const { POST } = await import('../route');
    const res = await POST(makeRequest({ plan: 'cmo' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing plan', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid plan', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ plan: 'enterprise' }));
    expect(res.status).toBe(400);
  });

  it('creates Stripe customer when stripe_customer_id is null', async () => {
    const { POST } = await import('../route');
    await POST(makeRequest({ plan: 'cmo' }));

    expect(mockStripe.customers.create).toHaveBeenCalledWith({
      email: 'test@example.com',
      metadata: { user_id: '00000000-0000-0000-0000-000000000001' },
    });
  });

  it('reuses existing Stripe customer when already set', async () => {
    mockServiceClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { stripe_customer_id: 'cus_existing_456' },
            error: null,
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    });

    const { POST } = await import('../route');
    await POST(makeRequest({ plan: 'cmo' }));

    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing_456' })
    );
  });

  it('creates checkout session with correct params and returns URL', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ plan: 'cmo' }));
    const json = await res.json();

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        client_reference_id: '00000000-0000-0000-0000-000000000001',
        line_items: [{ price: 'price_cmo', quantity: 1 }],
        success_url: 'http://localhost:3020/chat?checkout=success',
        cancel_url: 'http://localhost:3020/pricing?checkout=cancelled',
      })
    );
    expect(json.url).toBe('https://checkout.stripe.com/session_123');
  });
});
