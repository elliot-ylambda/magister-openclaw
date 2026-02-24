'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type PricingCardsProps = {
  isAuthenticated: boolean;
  currentPlan: 'cmo' | 'cmo_plus' | null;
};

const plans = [
  {
    slug: 'cmo' as const,
    name: 'CMO',
    price: '$299',
    period: '/mo',
    description: 'One autonomous marketing agent with 25 specialized skills.',
    features: ['25 marketing skills', 'Web & Slack access', 'Unlimited conversations'],
    highlighted: true,
  },
  {
    slug: 'cmo_plus' as const,
    name: 'CMO + Specialists',
    price: '$999',
    period: '/mo',
    description: '10+ agents working together — strategy, copy, SEO, ads, email, and more.',
    features: ['Everything in CMO', '10+ specialized agents', 'Priority support'],
    highlighted: false,
  },
];

export function PricingCards({ isAuthenticated, currentPlan }: PricingCardsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const hasSubscription = currentPlan !== null;

  async function handleCheckout(plan: string) {
    setLoading(plan);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('Checkout error:', res.status, body);
        return;
      }
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(null);
    }
  }

  async function handleManage() {
    setLoading('manage');
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('Portal error:', res.status, body);
        return;
      }
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl w-full">
      {plans.map((plan) => {
        const isCurrentPlan = currentPlan === plan.slug;

        return (
          <div
            key={plan.slug}
            className="relative rounded-xl border border-border p-8 flex flex-col"
            style={plan.highlighted ? { borderColor: 'hsl(var(--primary))' } : undefined}
          >
            {isCurrentPlan && (
              <Badge className="absolute top-4 right-4">Current plan</Badge>
            )}
            <h3 className="text-xl font-semibold">{plan.name}</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold">{plan.price}</span>
              <span className="text-muted-foreground">{plan.period}</span>
            </div>
            <p className="mt-4 text-sm text-muted-foreground flex-1">{plan.description}</p>
            <ul className="mt-6 space-y-2">
              {plan.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm">
                  <Check className="h-4 w-4 text-primary" />
                  {f}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              {!isAuthenticated ? (
                <Button asChild className="w-full" variant={plan.highlighted ? 'default' : 'outline'}>
                  <Link href={`/signup?plan=${plan.slug}`}>Get started</Link>
                </Button>
              ) : hasSubscription ? (
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={handleManage}
                  disabled={loading === 'manage'}
                >
                  {loading === 'manage' ? 'Loading...' : isCurrentPlan ? 'Manage subscription' : 'Switch plan'}
                </Button>
              ) : (
                <Button
                  className="w-full"
                  variant={plan.highlighted ? 'default' : 'outline'}
                  onClick={() => handleCheckout(plan.slug)}
                  disabled={loading === plan.slug}
                >
                  {loading === plan.slug ? 'Loading...' : 'Subscribe'}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
