import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const mockRequestReset = vi.fn();
const mockUpdatePassword = vi.fn();

vi.mock('@/app/(auth)/reset-password/actions', () => ({
  requestPasswordReset: (...args: unknown[]) => mockRequestReset(...args),
  updatePassword: (...args: unknown[]) => mockUpdatePassword(...args),
}));

import { ResetPasswordForm } from '../reset-password-form';

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    mockRequestReset.mockReset().mockResolvedValue({});
    mockUpdatePassword.mockReset().mockResolvedValue({});
  });

  describe('request mode', () => {
    it('renders email field and send button', () => {
      render(<ResetPasswordForm mode="request" />);
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
    });

    it('has link back to sign in', () => {
      render(<ResetPasswordForm mode="request" />);
      const link = screen.getByRole('link', { name: /back to sign in/i });
      expect(link).toHaveAttribute('href', '/login');
    });
  });

  describe('update mode', () => {
    it('renders password and confirm password fields', () => {
      render(<ResetPasswordForm mode="update" />);
      expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });

    it('renders update button', () => {
      render(<ResetPasswordForm mode="update" />);
      expect(screen.getByRole('button', { name: /update password/i })).toBeInTheDocument();
    });
  });
});
