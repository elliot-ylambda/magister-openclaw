import { describe, it, expect } from 'vitest';
import { isPublicRoute } from '@/middleware';

describe('isPublicRoute', () => {
  it.each([
    ['/', true],
    ['/login', true],
    ['/signup', true],
    ['/pricing', true],
    ['/reset-password', true],
  ])('%s → %s (exact match)', (path, expected) => {
    expect(isPublicRoute(path)).toBe(expected);
  });

  it.each([
    ['/auth/callback', true],
    ['/auth/confirm', true],
    ['/api/billing/webhook', true],
    ['/api/unsubscribe', true],
  ])('%s → %s (prefix match)', (path, expected) => {
    expect(isPublicRoute(path)).toBe(expected);
  });

  it.each([
    ['/chat', false],
    ['/dashboard', false],
    ['/admin', false],
    ['/settings', false],
    ['/chat/123', false],
  ])('%s → %s (protected)', (path, expected) => {
    expect(isPublicRoute(path)).toBe(expected);
  });
});
