"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { streamChat } from "@/lib/gateway";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessage, type Message } from "@/components/chat/chat-message";

const SCROLL_THRESHOLD = 100;
const WAKING_RETRY_DELAY = 5_000;

export function ChatSessionClient({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaking, setIsWaking] = useState(false);
  const [isFirstMessage, setIsFirstMessage] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();

  const isNearBottom = useCallback(() => {
    const el = scrollAreaRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (isNearBottom()) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isNearBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(
    async (content: string) => {
      setError(null);
      setIsWaking(false);

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: new Date(),
      };

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        createdAt: new Date(),
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setError("Session expired. Please sign in again.");
        setIsStreaming(false);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        return;
      }

      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      if (!gatewayUrl) {
        setError("Gateway URL not configured.");
        setIsStreaming(false);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        return;
      }

      let gotContent = false;

      try {
        for await (const event of streamChat(
          gatewayUrl,
          session.access_token,
          content,
          sessionId
        )) {
          switch (event.type) {
            case "session":
              // Session confirmed
              break;
            case "chunk":
              gotContent = true;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessage.id
                    ? { ...m, content: m.content + event.content }
                    : m
                )
              );
              break;
            case "done":
              break;
            case "error":
              if (event.message.includes("waking up")) {
                setIsWaking(true);
                setMessages((prev) =>
                  prev.filter((m) => m.id !== assistantMessage.id)
                );
                // Auto-retry after delay
                setTimeout(() => {
                  setIsWaking(false);
                  handleSend(content);
                }, WAKING_RETRY_DELAY);
                return;
              }
              if (!gotContent) {
                setMessages((prev) =>
                  prev.filter((m) => m.id !== assistantMessage.id)
                );
              }
              setError(event.message);
              break;
          }
        }
      } catch {
        if (!gotContent) {
          setMessages((prev) =>
            prev.filter((m) => m.id !== assistantMessage.id)
          );
        }
        setError("Connection lost. Please try again.");
      } finally {
        setIsStreaming(false);
      }

      // Update session title on first message
      if (isFirstMessage) {
        setIsFirstMessage(false);
        const title = content.slice(0, 50);
        await supabase
          .from("chat_sessions")
          .update({ title })
          .eq("id", sessionId);
        router.refresh();
      }
    },
    [sessionId, supabase, router, isFirstMessage]
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center pt-24 text-center">
              <p className="text-lg font-medium text-foreground mb-2">
                Start a conversation
              </p>
              <p className="text-sm text-muted-foreground max-w-sm">
                Previous conversation history is stored on your agent. Send a
                new message to continue.
              </p>
            </div>
          )}

          {messages.map((message, i) => (
            <ChatMessage
              key={message.id}
              message={message}
              isStreaming={
                isStreaming &&
                message.role === "assistant" &&
                i === messages.length - 1
              }
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Waking banner */}
      {isWaking && (
        <div className="mx-auto max-w-3xl w-full px-6">
          <div className="flex items-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-sm text-yellow-200">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waking your agent... This may take a moment.
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-auto max-w-3xl w-full px-6">
          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2.5 text-sm text-red-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
            <button
              className="ml-auto text-xs underline hover:no-underline"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <ChatInput onSend={handleSend} isStreaming={isStreaming || isWaking} />
    </div>
  );
}
