"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getAgentStatus, type AgentStatus } from "@/lib/gateway";
import { createClient } from "@/lib/supabase/client";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const STATUS_CONFIG: Record<
  AgentStatus["status"],
  { color: string; label: string; dot: boolean }
> = {
  running: { color: "bg-emerald-500", label: "Agent ready", dot: true },
  suspended: { color: "bg-yellow-500", label: "Agent sleeping", dot: true },
  provisioning: { color: "", label: "Setting up...", dot: false },
  suspending: { color: "bg-yellow-500", label: "Suspending...", dot: true },
  failed: { color: "bg-red-500", label: "Agent offline", dot: true },
  destroying: { color: "bg-muted-foreground", label: "Shutting down...", dot: true },
  destroyed: { color: "bg-muted-foreground", label: "Agent unavailable", dot: true },
};

const POLL_INTERVAL = 30_000;

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function AgentStatusBadge() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null);
  const supabase = createClient();

  const poll = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (!gatewayUrl) return;

    const result = await getAgentStatus(gatewayUrl, session.access_token);
    setStatus(result);
  }, [supabase]);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        poll();
        intervalRef.current = setInterval(poll, POLL_INTERVAL);
      } else if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [poll]);

  if (!status) return null;

  const config = STATUS_CONFIG[status.status];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
          {config.dot ? (
            <span className={`h-2 w-2 rounded-full ${config.color}`} />
          ) : (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          {config.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 text-sm" align="end">
        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Region</span>
            <span className="font-mono">{status.region}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last active</span>
            <span>
              {status.last_activity
                ? formatRelativeTime(status.last_activity)
                : "Never"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">LLM spend</span>
            <span>${(status.llm_spend_cents / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Plan</span>
            <span className="uppercase">{status.plan}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
