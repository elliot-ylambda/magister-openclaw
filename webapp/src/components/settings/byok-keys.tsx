'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type ProviderStatus = {
  connected: boolean;
  keySuffix: string | null;
};

type ByokStatus = {
  providers: Record<string, ProviderStatus>;
};

const PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', recommended: true, hint: 'One key for all models' },
  { id: 'anthropic', name: 'Anthropic', recommended: false, hint: '' },
  { id: 'openai', name: 'OpenAI', recommended: false, hint: '' },
  { id: 'gemini', name: 'Gemini', recommended: false, hint: '' },
] as const;

export function ByokKeys() {
  const [status, setStatus] = useState<ByokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const resp = await fetch('/api/byok/status');
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch {
      // Show empty state
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(provider: string) {
    const apiKey = inputs[provider]?.trim();
    if (!apiKey || apiKey.length < 10) {
      setMessage({ type: 'error', text: 'API key must be at least 10 characters.' });
      return;
    }

    setSaving(provider);
    setMessage(null);
    try {
      const resp = await fetch('/api/byok/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setStatus((prev) =>
          prev
            ? {
                providers: {
                  ...prev.providers,
                  [provider]: { connected: true, keySuffix: data.keySuffix },
                },
              }
            : prev
        );
        setInputs((prev) => ({ ...prev, [provider]: '' }));
        setMessage({ type: 'success', text: `${PROVIDERS.find((p) => p.id === provider)?.name} key saved.` });
      } else {
        const data = await resp.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error ?? 'Failed to save key.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save key.' });
    } finally {
      setSaving(null);
    }
  }

  async function handleRemove(provider: string) {
    setRemoving(provider);
    setMessage(null);
    try {
      const resp = await fetch('/api/byok/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (resp.ok) {
        setStatus((prev) =>
          prev
            ? {
                providers: {
                  ...prev.providers,
                  [provider]: { connected: false, keySuffix: null },
                },
              }
            : prev
        );
        setMessage({ type: 'success', text: `${PROVIDERS.find((p) => p.id === provider)?.name} key removed.` });
      } else {
        setMessage({ type: 'error', text: 'Failed to remove key.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to remove key.' });
    } finally {
      setRemoving(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">API Keys</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border p-6 space-y-4">
      <div>
        <h2 className="text-lg font-medium">API Keys</h2>
        <p className="text-sm text-muted-foreground">
          Use your own API keys for unrestricted model access and no usage limits.
        </p>
      </div>

      {message && (
        <div
          className={`rounded-md p-3 text-sm ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-500'
              : 'bg-destructive/10 text-destructive'
          }`}
          role={message.type === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-3">
        {PROVIDERS.map((provider) => {
          const providerStatus = status?.providers[provider.id];
          const isConnected = providerStatus?.connected ?? false;

          return (
            <div
              key={provider.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  {provider.recommended && (
                    <Badge variant="secondary" className="text-xs">Recommended</Badge>
                  )}
                  {isConnected && (
                    <Badge variant="outline" className="text-xs">Connected</Badge>
                  )}
                </div>
                {provider.hint && !isConnected && (
                  <p className="text-xs text-muted-foreground">{provider.hint}</p>
                )}
              </div>

              {isConnected ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    ••••{providerStatus?.keySuffix}
                  </span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleRemove(provider.id)}
                    disabled={removing === provider.id}
                  >
                    {removing === provider.id ? 'Removing...' : 'Remove'}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="sk-..."
                    className="h-8 w-48 font-mono text-xs"
                    value={inputs[provider.id] ?? ''}
                    onChange={(e) =>
                      setInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSave(provider.id)}
                    disabled={saving === provider.id || !inputs[provider.id]?.trim()}
                  >
                    {saving === provider.id ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
