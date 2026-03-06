'use client';

import { useEffect, useState, useCallback } from 'react';
import { Globe, Copy, X, Check, Monitor, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

type BrowserPolicy = {
  enabled: boolean;
  readOnly: boolean;
  allowedUrls: string[];
};

export function BrowserControl() {
  const [policy, setPolicy] = useState<BrowserPolicy | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Token generation
  const [token, setToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<string | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [copied, setCopied] = useState(false);

  // URL allowlist input
  const [urlInput, setUrlInput] = useState('');

  const fetchPolicy = useCallback(async () => {
    try {
      const [policyResp, statusResp] = await Promise.all([
        fetch('/api/browser/policy'),
        fetch('/api/browser/status'),
      ]);
      if (policyResp.ok) {
        setPolicy(await policyResp.json());
      }
      if (statusResp.ok) {
        const data = await statusResp.json();
        setConnected(data.connected);
      }
    } catch {
      // Show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);

  async function updatePolicy(updates: Partial<BrowserPolicy>) {
    setSaving(true);
    setMessage(null);
    try {
      const resp = await fetch('/api/browser/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (resp.ok) {
        setPolicy((prev) => prev ? { ...prev, ...updates } : prev);
        setMessage({ type: 'success', text: 'Settings updated.' });
      } else {
        const data = await resp.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error ?? 'Failed to update settings.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update settings.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateToken() {
    setGeneratingToken(true);
    setMessage(null);
    try {
      const resp = await fetch('/api/browser/token', { method: 'POST' });
      if (resp.ok) {
        const data = await resp.json();
        setToken(data.token);
        setTokenExpiry(data.expires_at);
      } else {
        setMessage({ type: 'error', text: 'Failed to generate token.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to generate token.' });
    } finally {
      setGeneratingToken(false);
    }
  }

  async function handleCopyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleAddUrl() {
    const domain = urlInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) return;
    if (policy?.allowedUrls.includes(domain)) {
      setMessage({ type: 'error', text: 'Domain already in allowlist.' });
      return;
    }
    const updated = [...(policy?.allowedUrls ?? []), domain];
    setUrlInput('');
    updatePolicy({ allowedUrls: updated });
  }

  function handleRemoveUrl(domain: string) {
    const updated = (policy?.allowedUrls ?? []).filter((u) => u !== domain);
    updatePolicy({ allowedUrls: updated });
  }

  function formatExpiry(iso: string): string {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const mins = Math.ceil(diff / 60_000);
    return `Expires in ${mins}m`;
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">Browser Control</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-medium">Browser Control</h2>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <Badge variant="secondary" className="gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              Disconnected
            </Badge>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Let your AI agent control your Chrome browser. Install the extension and connect it to your agent.
      </p>

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

      {/* Enable toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div>
          <Label htmlFor="browser-enabled" className="text-sm font-medium">
            Enable browser control
          </Label>
          <p className="text-xs text-muted-foreground">
            Allow your agent to interact with your browser
          </p>
        </div>
        <Switch
          id="browser-enabled"
          checked={policy?.enabled ?? false}
          onCheckedChange={(checked) => updatePolicy({ enabled: checked })}
          disabled={saving}
        />
      </div>

      {policy?.enabled && (
        <>
          {/* Connection Token */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Connection Token</Label>
            <p className="text-xs text-muted-foreground">
              Generate a one-time token to connect your Chrome extension.
            </p>
            {token ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={token}
                    className="h-8 font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyToken}
                    className="shrink-0"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                {tokenExpiry && (
                  <p className="text-xs text-muted-foreground">
                    {formatExpiry(tokenExpiry)}
                  </p>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                onClick={handleGenerateToken}
                disabled={generatingToken}
              >
                {generatingToken ? 'Generating...' : 'Generate Token'}
              </Button>
            )}
          </div>

          {/* Read-only toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <Label htmlFor="browser-readonly" className="text-sm font-medium">
                Read-only mode
              </Label>
              <p className="text-xs text-muted-foreground">
                Agent can view pages but cannot click, type, or navigate
              </p>
            </div>
            <Switch
              id="browser-readonly"
              checked={policy?.readOnly ?? false}
              onCheckedChange={(checked) => updatePolicy({ readOnly: checked })}
              disabled={saving}
            />
          </div>

          {/* URL Allowlist */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">URL Allowlist</Label>
            <p className="text-xs text-muted-foreground">
              Restrict which domains the agent can navigate to. Leave empty to allow all.
            </p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Globe className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="example.com"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddUrl(); }}
                  className="h-8 pl-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                onClick={handleAddUrl}
                disabled={saving || !urlInput.trim()}
              >
                Add
              </Button>
            </div>
            {(policy?.allowedUrls?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {policy?.allowedUrls.map((url) => (
                  <Badge key={url} variant="secondary" className="gap-1 pr-1">
                    {url}
                    <button
                      onClick={() => handleRemoveUrl(url)}
                      className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Install link */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Chrome Extension</p>
            <p className="text-xs text-muted-foreground">
              Install the Magister Browser Control extension to connect your browser.
            </p>
            <div className="flex items-center gap-2">
              <a href="/extension" target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="gap-1.5">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Learn More
                </Button>
              </a>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
