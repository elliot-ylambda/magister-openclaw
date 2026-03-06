"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import { submitContactSupport } from "@/lib/gateway";

export function ContactSupportPopover() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const cooldownRef = useRef(false);
  const supabase = createClient();

  useEffect(() => {
    if (open) {
      setMessage("");
      setStatus("idle");
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (!message.trim() || cooldownRef.current) return;

    setStatus("sending");
    cooldownRef.current = true;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!session || !gatewayUrl) {
        setStatus("error");
        return;
      }

      await submitContactSupport(gatewayUrl, session.access_token, message.trim());

      setStatus("sent");
      setTimeout(() => setOpen(false), 2000);
    } catch {
      setStatus("error");
    } finally {
      setTimeout(() => {
        cooldownRef.current = false;
      }, 5000);
    }
  }, [message, supabase]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <MessageCircle className="h-4 w-4" />
          <span className="hidden sm:inline">Support</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-80">
        {status === "sent" ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            Message sent — we&apos;ll get back to you soon!
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">Contact Support</p>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="How can we help?"
              rows={3}
              className="resize-none text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleSubmit();
                }
              }}
            />

            {status === "error" && (
              <p className="text-xs text-red-400">
                Failed to send. Please try again.
              </p>
            )}

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!message.trim() || status === "sending"}
                className="gap-1.5"
              >
                <Send className="h-3.5 w-3.5" />
                {status === "sending" ? "Sending..." : "Send"}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
