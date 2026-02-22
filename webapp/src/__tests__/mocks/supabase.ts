import { vi } from 'vitest';
import type { User, Session } from '@supabase/supabase-js';

export function createMockUser(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'test@example.com',
    email_confirmed_at: '2026-01-01T00:00:00Z',
    phone: '',
    confirmed_at: '2026-01-01T00:00:00Z',
    last_sign_in_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    is_anonymous: false,
    ...overrides,
  };
}

export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: createMockUser(),
    ...overrides,
  };
}

function createChainableQuery(returnValue: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    like: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(returnValue),
    maybeSingle: vi.fn().mockResolvedValue(returnValue),
    then: vi.fn((resolve) => resolve(returnValue)),
  };

  // Make the chain itself thenable for await
  Object.defineProperty(chain, 'then', {
    value: (resolve: (value: unknown) => void) => Promise.resolve(returnValue).then(resolve),
    writable: true,
  });

  return chain;
}

export function createMockSupabaseClient(options: {
  user?: User | null;
  session?: Session | null;
  queryData?: unknown;
  queryError?: unknown;
} = {}) {
  const {
    user = null,
    session = null,
    queryData = null,
    queryError = null,
  } = options;

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      signInWithPassword: vi.fn().mockResolvedValue({ data: { user, session }, error: null }),
      signUp: vi.fn().mockResolvedValue({ data: { user, session }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: { url: 'https://oauth.mock' }, error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
      updateUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    from: vi.fn().mockReturnValue(createChainableQuery({ data: queryData, error: queryError })),
  };
}
