import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const mockLogin = vi.fn();
vi.mock('@/app/(auth)/login/actions', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

import { LoginForm } from '../login-form';

describe('LoginForm', () => {
  beforeEach(() => {
    mockLogin.mockReset();
    mockLogin.mockResolvedValue({});
  });

  it('renders email and password fields', () => {
    render(<LoginForm />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('has link to signup page', () => {
    render(<LoginForm />);
    const link = screen.getByRole('link', { name: /sign up/i });
    expect(link).toHaveAttribute('href', '/signup');
  });

  it('has link to reset password page', () => {
    render(<LoginForm />);
    const link = screen.getByRole('link', { name: /forgot password/i });
    expect(link).toHaveAttribute('href', '/reset-password');
  });
});
