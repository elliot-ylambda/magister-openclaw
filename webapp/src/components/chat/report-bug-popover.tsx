"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { submitFeedback } from "@/lib/gateway";

const CATEGORIES = [
  { value: "bug", label: "Bug" },
  { value: "wrong_answer", label: "Wrong Answer" },
  { value: "slow", label: "Slow" },
  { value: "other", label: "Other" },
] as const;

type FeedbackCategory = (typeof CATEGORIES)[number]["value"];

export function ReportBugPopover({
  sessionId,
  messages,
  disabled,
}: {
  sessionId: string;
  messages: { role: string; content: string }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const cooldownRef = useRef(false);
  const supabase = createClient();

  // Reset form when popover opens
  useEffect(() => {
    if (open) {
      setCategory(null);
      setDescription("");
      setStatus("idle");
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!category || cooldownRef.current) return;

    setStatus("sending");
    cooldownRef.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!session || !gatewayUrl) {
        setStatus("error");
        return;
      }

      const trimmed = messages.slice(-20).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      await submitFeedback(gatewayUrl, session.access_token, {
        sessionId,
        category,
        description: description.trim() || undefined,
        messages: trimmed,
      });

      setStatus("sent");
      setTimeout(() => setOpen(false), 2000);
    } catch {
      setStatus("error");
    } finally {
      setTimeout(() => {
        cooldownRef.current = false;
      }, 5000);
    }
  }, [category, description, messages, sessionId, supabase]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          className="rounded-lg text-muted-foreground hover:text-foreground"
        >
          <Bug className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80">
        {status === "sent" ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            Report sent — thanks!
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">Report an Issue</p>

            {/* Category chips */}
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setCategory(cat.value)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    category === cat.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Description */}
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details..."
              rows={2}
              className="resize-none text-sm"
            />

            <p className="text-[11px] text-muted-foreground">
              Session context will be included automatically.
            </p>

            {status === "error" && (
              <p className="text-xs text-red-400">
                Failed to send. Please try again.
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!category || status === "sending"}
              >
                {status === "sending" ? "Sending..." : "Send Report"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
