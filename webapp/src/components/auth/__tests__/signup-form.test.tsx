import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const mockSignup = vi.fn();
vi.mock('@/app/(auth)/signup/actions', () => ({
  signup: (...args: unknown[]) => mockSignup(...args),
}));

import { SignupForm } from '../signup-form';

describe('SignupForm', () => {
  beforeEach(() => {
    mockSignup.mockReset();
    mockSignup.mockResolvedValue({});
  });

  it('renders email and password fields', () => {
    render(<SignupForm />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('renders create account button', () => {
    render(<SignupForm />);
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('has link to login page', () => {
    render(<SignupForm />);
    const link = screen.getByRole('link', { name: /sign in/i });
    expect(link).toHaveAttribute('href', '/login');
  });

  it('renders page heading', () => {
    render(<SignupForm />);
    expect(screen.getByText('Create an account')).toBeInTheDocument();
  });
});
