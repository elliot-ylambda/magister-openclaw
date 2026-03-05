import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExchangeCodeForSession = vi.fn();
const mockVerifyOtp = vi.fn();
const mockSignOut = vi.fn();
const mockDeleteUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
  }),
  createServiceClient: vi.fn(() => ({
    from: mockFrom,
    auth: { admin: { deleteUser: mockDeleteUser } },
  })),
}));

import { GET } from '../route';

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3020/auth/callback');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new Request(url.toString());
}

function makeOAuthUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-123',
    email: 'test@example.com',
    created_at: new Date().toISOString(),
    app_metadata: { provider: 'google' },
    ...overrides,
  };
}

describe('GET /auth/callback', () => {
  beforeEach(() => {
    mockExchangeCodeForSession.mockReset();
    mockVerifyOtp.mockReset();
    mockSignOut.mockReset();
    mockDeleteUser.mockReset();
    mockMaybeSingle.mockReset();
    mockEq.mockReset().mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockSelect.mockReset().mockReturnValue({ eq: mockEq });
    mockFrom.mockReset().mockReturnValue({ select: mockSelect });
  });

  it('exchanges code for session and redirects to /chat', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user: makeOAuthUser({ app_metadata: { provider: 'email' } }) } },
      error: null,
    });
    const response = await GET(makeRequest({ code: 'valid-code' }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/chat');
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('valid-code');
  });

  it('redirects to /reset-password?mode=update for recovery type', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user: makeOAuthUser({ app_metadata: { provider: 'email' } }) } },
      error: null,
    });
    const response = await GET(makeRequest({ code: 'recovery-code', type: 'recovery' }));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/reset-password');
    expect(location.searchParams.get('mode')).toBe('update');
  });

  it('redirects to /login on code exchange error', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: 'expired' } });
    const response = await GET(makeRequest({ code: 'bad-code' }));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('redirects to custom next param on success', async () => {
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user: makeOAuthUser({ app_metadata: { provider: 'email' } }) } },
      error: null,
    });
    const response = await GET(makeRequest({ code: 'valid-code', next: '/dashboard' }));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/dashboard');
  });

  it('handles token_hash verification', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    const response = await GET(makeRequest({ token_hash: 'abc123', type: 'email' }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/chat');
  });

  it('redirects to /login when no code or token_hash', async () => {
    const response = await GET(makeRequest({}));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  // OAuth allowlist enforcement tests

  it('deletes new OAuth user not in allowlist and redirects to signup', async () => {
    const user = makeOAuthUser();
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({ data: null });
    mockDeleteUser.mockResolvedValue({});
    mockSignOut.mockResolvedValue({});

    const response = await GET(makeRequest({ code: 'oauth-code' }));
    const location = new URL(response.headers.get('location')!);

    expect(location.pathname).toBe('/signup');
    expect(location.searchParams.get('error')).toBe('not_allowlisted');
    expect(mockDeleteUser).toHaveBeenCalledWith('user-123');
    expect(mockSignOut).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalledWith('signup_allowlist');
    expect(mockEq).toHaveBeenCalledWith('email', 'test@example.com');
  });

  it('allows new OAuth user that is in allowlist', async () => {
    const user = makeOAuthUser();
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    });
    mockMaybeSingle.mockResolvedValue({ data: { email: 'test@example.com' } });

    const response = await GET(makeRequest({ code: 'oauth-code' }));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/chat');
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('skips allowlist check for existing OAuth users (old created_at)', async () => {
    const user = makeOAuthUser({
      created_at: new Date(Date.now() - 60_000).toISOString(), // 60 seconds ago
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { user } },
      error: null,
    });

    const response = await GET(makeRequest({ code: 'oauth-code' }));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/chat');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});
