'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { SecretOverride, UserProfile } from './secrets-manager';

type UserSecretOverridesProps = {
  secretKey: string;
  overrides: SecretOverride[];
  profiles: UserProfile[];
  onUpdate: () => void;
};

export function UserSecretOverrides({ secretKey, overrides, profiles, onUpdate }: UserSecretOverridesProps) {
  const [adding, setAdding] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [overrideValue, setOverrideValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const profileMap = new Map(profiles.map((p) => [p.id, p.email]));
  // Filter out profiles that already have an override
  const overriddenUserIds = new Set(overrides.map((o) => o.user_id));
  const availableProfiles = profiles.filter((p) => !overriddenUserIds.has(p.id));

  async function handleSave() {
    if (!selectedUserId || !overrideValue) {
      setError('Select a user and enter a value');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert_override',
          user_id: selectedUserId,
          secret_key: secretKey,
          value: overrideValue,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error);
        return;
      }
      setAdding(false);
      setSelectedUserId('');
      setOverrideValue('');
      onUpdate();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(userId: string) {
    const res = await fetch('/api/admin/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete_override',
        user_id: userId,
        secret_key: secretKey,
      }),
    });
    if (res.ok) onUpdate();
  }

  async function handlePushToUser(userId: string) {
    setPushing(userId);
    try {
      await fetch('/api/admin/secrets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
    } finally {
      setPushing(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Overrides for <code className="text-xs">{secretKey}</code>
        </h3>
        {!adding && availableProfiles.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add Override
          </Button>
        )}
      </div>

      {overrides.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">No per-user overrides</p>
      )}

      {overrides.map((override) => (
        <div key={override.id} className="flex items-center gap-3 text-sm">
          <span className="w-48 truncate">{profileMap.get(override.user_id) ?? override.user_id}</span>
          <code className="text-xs text-muted-foreground">
            {override.value.length > 8
              ? override.value.slice(0, 2) + '****' + override.value.slice(-2)
              : '****'}
          </code>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={pushing === override.user_id}
              onClick={() => handlePushToUser(override.user_id)}
            >
              {pushing === override.user_id ? 'Pushing...' : 'Push to User'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive"
              onClick={() => handleDelete(override.user_id)}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      {adding && (
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">User</label>
            <select
              className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              <option value="">Select user...</option>
              {availableProfiles.map((p) => (
                <option key={p.id} value={p.id}>{p.email}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Value</label>
            <Input
              type="password"
              className="w-48"
              placeholder="Override value"
              value={overrideValue}
              onChange={(e) => setOverrideValue(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setError(null); }}>
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
