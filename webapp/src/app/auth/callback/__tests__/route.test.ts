import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExchangeCodeForSession = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    },
  }),
}));

import { GET } from '../route';

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3020/auth/callback');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new Request(url.toString());
}

describe('GET /auth/callback', () => {
  beforeEach(() => {
    mockExchangeCodeForSession.mockReset();
    mockVerifyOtp.mockReset();
  });

  it('exchanges code for session and redirects to /chat', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    const response = await GET(makeRequest({ code: 'valid-code' }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/chat');
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('valid-code');
  });

  it('redirects to /reset-password?mode=update for recovery type', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
    const response = await GET(makeRequest({ code: 'recovery-code', type: 'recovery' }));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/reset-password');
    expect(location.searchParams.get('mode')).toBe('update');
  });

  it('redirects to /login on code exchange error', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: { message: 'expired' } });
    const response = await GET(makeRequest({ code: 'bad-code' }));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('redirects to custom next param on success', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: null });
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
});
