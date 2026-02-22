'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function ManageBillingButton({ returnUrl = '/dashboard' }: { returnUrl?: string }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={loading}>
      {loading ? 'Loading...' : 'Manage billing'}
    </Button>
  );
}
