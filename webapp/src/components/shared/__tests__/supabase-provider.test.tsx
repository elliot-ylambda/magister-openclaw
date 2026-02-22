import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// Mock the browser client
const mockGetSession = vi.fn().mockResolvedValue({ data: { session: null } });
const mockOnAuthStateChange = vi.fn().mockReturnValue({
  data: { subscription: { unsubscribe: vi.fn() } },
});

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
    },
  }),
}));

// Import after mocks are set up
import { SupabaseProvider, useAuth } from '@/components/shared/supabase-provider';

function AuthConsumer() {
  const { user, session, isLoading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user">{user ? user.email : 'null'}</span>
      <span data-testid="session">{session ? 'active' : 'null'}</span>
    </div>
  );
}

describe('SupabaseProvider', () => {
  it('renders children', () => {
    render(
      <SupabaseProvider>
        <div data-testid="child">Hello</div>
      </SupabaseProvider>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('provides auth context with null user when not logged in', async () => {
    render(
      <SupabaseProvider>
        <AuthConsumer />
      </SupabaseProvider>
    );

    // Initially loading
    expect(screen.getByTestId('user')).toHaveTextContent('null');
    expect(screen.getByTestId('session')).toHaveTextContent('null');
  });

  it('subscribes to auth state changes', () => {
    render(
      <SupabaseProvider>
        <div>Test</div>
      </SupabaseProvider>
    );

    expect(mockOnAuthStateChange).toHaveBeenCalled();
  });
});
