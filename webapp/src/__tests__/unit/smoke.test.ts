import { describe, it, expect } from 'vitest';

describe('test setup', () => {
  it('vitest is configured correctly', () => {
    expect(1 + 1).toBe(2);
  });

  it('path alias works', async () => {
    const { cn } = await import('@/lib/utils');
    expect(cn('a', 'b')).toBe('a b');
  });
});
