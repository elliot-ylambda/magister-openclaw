import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/headers
const mockCookieStore = {
  getAll: vi.fn().mockReturnValue([]),
  set: vi.fn(),
};
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
}));

// Mock @supabase/ssr
const mockServerClient = {
  auth: { getUser: vi.fn(), getSession: vi.fn() },
  from: vi.fn(),
};
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => mockServerClient),
  createBrowserClient: vi.fn(() => ({
    auth: { getUser: vi.fn(), getSession: vi.fn() },
    from: vi.fn(),
  })),
}));

// Mock @supabase/supabase-js
const mockServiceClient = {
  auth: { getUser: vi.fn(), getSession: vi.fn() },
  from: vi.fn(),
};
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockServiceClient),
}));

describe('Supabase server utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  });

  it('createClient() returns a valid Supabase client', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const client = await createClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
    expect(client.from).toBeDefined();
  });

  it('createServiceClient() returns a valid client', async () => {
    const { createServiceClient } = await import('@/lib/supabase/server');
    const client = createServiceClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
    expect(client.from).toBeDefined();
  });
});

describe('Supabase browser client', () => {
  it('returns the same instance on repeated calls (singleton)', async () => {
    // Reset module to get fresh singleton state
    vi.resetModules();

    // Re-mock dependencies after module reset
    vi.mock('@supabase/ssr', () => {
      const instance = {
        auth: { getUser: vi.fn(), getSession: vi.fn() },
        from: vi.fn(),
      };
      return {
        createServerClient: vi.fn(() => instance),
        createBrowserClient: vi.fn(() => instance),
      };
    });

    const { createClient } = await import('@/lib/supabase/client');
    const client1 = createClient();
    const client2 = createClient();
    expect(client1).toBe(client2);
  });
});
