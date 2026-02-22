import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import AuthLayout from '../layout';

describe('AuthLayout', () => {
  it('renders children', () => {
    render(
      <AuthLayout>
        <div data-testid="child">Hello</div>
      </AuthLayout>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('renders Magister logo linking to home', () => {
    render(
      <AuthLayout>
        <div>Test</div>
      </AuthLayout>
    );
    const logo = screen.getByText('Magister');
    expect(logo).toBeInTheDocument();
    expect(logo.closest('a')).toHaveAttribute('href', '/');
  });
});
