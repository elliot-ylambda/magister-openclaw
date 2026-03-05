'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type SlackStatus = {
  connected: boolean;
  teamName: string | null;
  connectedAt: string | null;
};

export function SlackConnection() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchStatus();

    // Show message from OAuth redirect
    const slackParam = searchParams.get('slack');
    if (slackParam === 'connected') {
      setMessage({ type: 'success', text: 'Slack workspace connected successfully.' });
    } else if (slackParam === 'error') {
      const reason = searchParams.get('reason') ?? 'unknown';
      setMessage({ type: 'error', text: `Failed to connect Slack: ${reason}` });
    }
  }, [searchParams]);

  async function fetchStatus() {
    try {
      const resp = await fetch('/api/slack/status');
      if (resp.ok) {
        setStatus(await resp.json());
      }
    } catch {
      // Silently fail — will show disconnected state
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    // Get a signed state token from the server
    const resp = await fetch('/api/slack/connect', { method: 'POST' });
    if (!resp.ok) return;
    const { url } = await resp.json();
    window.location.href = url;
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const resp = await fetch('/api/slack/disconnect', { method: 'POST' });
      if (resp.ok) {
        setStatus({ connected: false, teamName: null, connectedAt: null });
        setMessage({ type: 'success', text: 'Slack disconnected.' });
      } else {
        setMessage({ type: 'error', text: 'Failed to disconnect Slack.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to disconnect Slack.' });
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-border p-6 space-y-4">
        <h2 className="text-lg font-medium">Slack Integration</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Slack Integration</h2>
        {status?.connected && (
          <Badge variant="secondary">Connected</Badge>
        )}
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

      {status?.connected ? (
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Workspace</span>
            <span className="font-medium">{status.teamName}</span>
          </div>
          {status.connectedAt && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Connected</span>
              <span>
                {new Date(status.connectedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Your agent responds to DMs and @mentions in this workspace.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect your Slack workspace to chat with your marketing agent via DMs and @mentions.
          </p>
          <button
            onClick={handleConnect}
            className="flex items-center gap-2 rounded border border-[#ddd] bg-white px-3 py-2 text-sm font-semibold text-[#333] shadow-sm hover:shadow transition-shadow"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
              <path d="M6.527 14.514A1.636 1.636 0 1 1 4.89 12.88h1.636v1.635Zm.827 0a1.636 1.636 0 1 1 3.272 0v4.09a1.636 1.636 0 1 1-3.272 0v-4.09Z" fill="#2EB67D" />
              <path d="M9.49 6.527A1.636 1.636 0 1 1 11.124 4.89V6.527H9.49Zm0 .827a1.636 1.636 0 1 1 0 3.272H5.4a1.636 1.636 0 1 1 0-3.272h4.09Z" fill="#ECB22E" />
              <path d="M17.473 9.49a1.636 1.636 0 1 1 1.636 1.636h-1.636V9.49Zm-.827 0a1.636 1.636 0 1 1-3.272 0V5.4a1.636 1.636 0 1 1 3.272 0v4.09Z" fill="#E01E5A" />
              <path d="M14.51 17.473a1.636 1.636 0 1 1-1.636 1.636v-1.636h1.635Zm0-.827a1.636 1.636 0 1 1 0-3.272h4.09a1.636 1.636 0 1 1 0 3.272h-4.09Z" fill="#36C5F0" />
            </svg>
            Connect to Slack
          </button>
        </div>
      )}
    </section>
  );
}
