import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockUser, createMockSupabaseClient } from '@/__tests__/mocks/supabase';
import { http, HttpResponse } from 'msw';
import { server } from '@/__tests__/mocks/server';

const mockUser = createMockUser();
const mockSupabaseClient = createMockSupabaseClient({ user: mockUser });
const mockServiceClient = createMockSupabaseClient();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(mockSupabaseClient),
  createServiceClient: vi.fn().mockReturnValue(mockServiceClient),
}));

function mockAdminRole() {
  mockServiceClient.from.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { role: 'admin' },
          error: null,
        }),
      }),
    }),
  });
}

function mockNonAdminRole() {
  mockServiceClient.from.mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { role: 'user' },
          error: null,
        }),
      }),
    }),
  });
}

describe('/api/admin/default-model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GATEWAY_URL = 'http://gateway:8080';
    process.env.GATEWAY_API_KEY = 'test-key';

    mockSupabaseClient.auth.getUser.mockResolvedValue({
      data: { user: mockUser },
      error: null,
    });

    mockAdminRole();
  });

  describe('GET', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabaseClient.auth.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Not authenticated' },
      });

      const { GET } = await import('../route');
      const res = await GET();
      expect(res.status).toBe(401);
    });

    it('returns 403 when not admin', async () => {
      mockNonAdminRole();

      const { GET } = await import('../route');
      const res = await GET();
      expect(res.status).toBe(403);
    });

    it('proxies to gateway and returns result', async () => {
      server.use(
        http.get('http://gateway:8080/api/admin/default-model', () => {
          return HttpResponse.json({ default_model: 'openai/gpt-5.2' });
        }),
      );

      const { GET } = await import('../route');
      const res = await GET();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.default_model).toBe('openai/gpt-5.2');
    });
  });

  describe('POST', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabaseClient.auth.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'Not authenticated' },
      });

      const { POST } = await import('../route');
      const res = await POST(new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ model: 'openai/gpt-5.2' }),
      }));
      expect(res.status).toBe(401);
    });

    it('returns 400 when model is missing', async () => {
      const { POST } = await import('../route');
      const res = await POST(new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({}),
      }));
      expect(res.status).toBe(400);
    });

    it('proxies to gateway and returns result', async () => {
      server.use(
        http.post('http://gateway:8080/api/admin/default-model', () => {
          return HttpResponse.json({ status: 'updated', default_model: 'openai/gpt-5.2' });
        }),
      );

      const { POST } = await import('../route');
      const res = await POST(new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ model: 'openai/gpt-5.2' }),
      }));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('updated');
    });
  });
});
