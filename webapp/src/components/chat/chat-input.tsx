"use client";

import { useCallback, useRef } from "react";
import { ArrowUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

const MAX_ROWS = 5;
const LINE_HEIGHT = 24;
const PADDING = 16;

export function ChatInput({
  onSend,
  isStreaming,
}: {
  onSend: (message: string) => void;
  isStreaming: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value.trim();
    if (!value || isStreaming) return;
    onSend(value);
    el.value = "";
    el.style.height = "auto";
  }, [onSend, isStreaming]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="sticky bottom-0 border-t bg-background p-4">
      <div className="relative mx-auto max-w-3xl">
        <Textarea
          ref={textareaRef}
          onInput={adjustHeight}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          placeholder={
            isStreaming ? "Agent is working..." : "Send a message..."
          }
          className="min-h-[48px] resize-none pr-12 rounded-xl"
          rows={1}
        />
        <Button
          size="icon-sm"
          onClick={handleSend}
          disabled={isStreaming}
          className="absolute right-2 bottom-2 rounded-lg"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
