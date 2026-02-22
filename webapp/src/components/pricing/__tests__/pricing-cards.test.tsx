import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { PricingCards } from '../pricing-cards';

describe('PricingCards', () => {
  it('renders both plan cards with correct prices', () => {
    render(<PricingCards isAuthenticated={false} currentPlan={null} />);
    expect(screen.getByText('$299')).toBeInTheDocument();
    expect(screen.getByText('$999')).toBeInTheDocument();
    expect(screen.getByText('CMO')).toBeInTheDocument();
    expect(screen.getByText('CMO + Specialists')).toBeInTheDocument();
  });

  describe('unauthenticated', () => {
    it('renders Get started links to signup', () => {
      render(<PricingCards isAuthenticated={false} currentPlan={null} />);
      const links = screen.getAllByRole('link', { name: /get started/i });
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute('href', '/signup?plan=cmo');
      expect(links[1]).toHaveAttribute('href', '/signup?plan=cmo_plus');
    });
  });

  describe('authenticated without subscription', () => {
    it('renders Subscribe buttons', () => {
      render(<PricingCards isAuthenticated={true} currentPlan={null} />);
      const buttons = screen.getAllByRole('button', { name: /subscribe/i });
      expect(buttons).toHaveLength(2);
    });
  });

  describe('authenticated with subscription', () => {
    it('shows Current plan badge on active plan', () => {
      render(<PricingCards isAuthenticated={true} currentPlan="cmo" />);
      expect(screen.getByText('Current plan')).toBeInTheDocument();
    });

    it('shows Manage subscription for current plan', () => {
      render(<PricingCards isAuthenticated={true} currentPlan="cmo" />);
      expect(screen.getByRole('button', { name: /manage subscription/i })).toBeInTheDocument();
    });

    it('shows Switch plan for other plan', () => {
      render(<PricingCards isAuthenticated={true} currentPlan="cmo" />);
      expect(screen.getByRole('button', { name: /switch plan/i })).toBeInTheDocument();
    });
  });
});
