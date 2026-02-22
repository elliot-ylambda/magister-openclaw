import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockUser, createMockSupabaseClient } from '@/__tests__/mocks/supabase';

const mockSupabaseClient = createMockSupabaseClient({ user: createMockUser() });
const mockServiceClient = createMockSupabaseClient();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseClient),
  createServiceClient: vi.fn().mockReturnValue(mockServiceClient),
}));

const mockStripe = {
  billingPortal: {
    sessions: {
      create: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_123' }),
    },
  },
};

vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn().mockReturnValue(mockStripe),
}));

describe('POST /api/stripe/portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3020';

    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: createMockUser() },
      error: null,
    });
  });

  it('returns 401 when not authenticated', async () => {
    mockSupabaseClient.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Not authenticated' },
    });

    const { POST } = await import('../route');
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('returns 404 when no stripe_customer_id', async () => {
    mockServiceClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { stripe_customer_id: null },
            error: null,
          }),
        }),
      }),
    });

    const { POST } = await import('../route');
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it('creates portal session with correct customer and return_url', async () => {
    mockServiceClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { stripe_customer_id: 'cus_existing_789' },
            error: null,
          }),
        }),
      }),
    });

    const { POST } = await import('../route');
    await POST();

    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_existing_789',
      return_url: 'http://localhost:3020/chat',
    });
  });

  it('returns url from portal session', async () => {
    mockServiceClient.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { stripe_customer_id: 'cus_existing_789' },
            error: null,
          }),
        }),
      }),
    });

    const { POST } = await import('../route');
    const res = await POST();
    const json = await res.json();
    expect(json.url).toBe('https://billing.stripe.com/portal_123');
  });
});
