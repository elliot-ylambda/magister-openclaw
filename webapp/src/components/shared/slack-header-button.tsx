'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL = 30_000;

export function SlackHeaderButton() {
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null);

  const poll = useCallback(() => {
    fetch('/api/slack/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setConnected(data.connected);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    const handleVisibility = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (document.visibilityState === 'visible') {
        poll();
        intervalRef.current = setInterval(poll, POLL_INTERVAL);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [poll]);

  async function handleConnect() {
    setConnecting(true);
    try {
      const resp = await fetch('/api/slack/connect', { method: 'POST' });
      if (!resp.ok) return;
      const { url } = await resp.json();
      window.location.href = url;
    } catch {
      setConnecting(false);
    }
  }

  if (!loaded) return null;

  if (connected) {
    return (
      <span className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <path d="M6.527 14.514A1.636 1.636 0 1 1 4.89 12.88h1.636v1.635Zm.827 0a1.636 1.636 0 1 1 3.272 0v4.09a1.636 1.636 0 1 1-3.272 0v-4.09Z" fill="#2EB67D" />
          <path d="M9.49 6.527A1.636 1.636 0 1 1 11.124 4.89V6.527H9.49Zm0 .827a1.636 1.636 0 1 1 0 3.272H5.4a1.636 1.636 0 1 1 0-3.272h4.09Z" fill="#ECB22E" />
          <path d="M17.473 9.49a1.636 1.636 0 1 1 1.636 1.636h-1.636V9.49Zm-.827 0a1.636 1.636 0 1 1-3.272 0V5.4a1.636 1.636 0 1 1 3.272 0v4.09Z" fill="#E01E5A" />
          <path d="M14.51 17.473a1.636 1.636 0 1 1-1.636 1.636v-1.636h1.635Zm0-.827a1.636 1.636 0 1 1 0-3.272h4.09a1.636 1.636 0 1 1 0 3.272h-4.09Z" fill="#36C5F0" />
        </svg>
        Slack connected
      </span>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      className="flex-shrink-0 flex items-center gap-1.5 rounded border border-[#ddd] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#333] shadow-sm hover:shadow transition-shadow disabled:opacity-50"
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
        <path d="M6.527 14.514A1.636 1.636 0 1 1 4.89 12.88h1.636v1.635Zm.827 0a1.636 1.636 0 1 1 3.272 0v4.09a1.636 1.636 0 1 1-3.272 0v-4.09Z" fill="#2EB67D" />
        <path d="M9.49 6.527A1.636 1.636 0 1 1 11.124 4.89V6.527H9.49Zm0 .827a1.636 1.636 0 1 1 0 3.272H5.4a1.636 1.636 0 1 1 0-3.272h4.09Z" fill="#ECB22E" />
        <path d="M17.473 9.49a1.636 1.636 0 1 1 1.636 1.636h-1.636V9.49Zm-.827 0a1.636 1.636 0 1 1-3.272 0V5.4a1.636 1.636 0 1 1 3.272 0v4.09Z" fill="#E01E5A" />
        <path d="M14.51 17.473a1.636 1.636 0 1 1-1.636 1.636v-1.636h1.635Zm0-.827a1.636 1.636 0 1 1 0-3.272h4.09a1.636 1.636 0 1 1 0 3.272h-4.09Z" fill="#36C5F0" />
      </svg>
      Connect to Slack
    </button>
  );
}
