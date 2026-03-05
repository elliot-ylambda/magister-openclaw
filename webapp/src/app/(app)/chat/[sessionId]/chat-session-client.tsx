"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { streamChat, getAvailableModels, type Attachment } from "@/lib/gateway";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessage, type Message, type MessageAttachment, type ToolUse } from "@/components/chat/chat-message";
import { MODEL_DISPLAY_NAMES, MODEL_OUTPUT_PRICES } from "@/components/chat/model-picker";

const SCROLL_THRESHOLD = 100;
const WAKING_RETRY_DELAY = 5_000;
const MAX_WAKE_RETRIES = 3;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function ChatSessionClient({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaking, setIsWaking] = useState(false);
  const [currentModelLabel, setCurrentModelLabel] = useState<string | null>(null);
  const currentModelLabelRef = useRef<string | null>(null);
  const currentModelIdRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  const isFirstMessageRef = useRef(true);
  const retryCountRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();

  const makeSystemMessage = useCallback((content: string): Message => ({
    id: `system-${crypto.randomUUID()}`,
    role: "system",
    content,
    createdAt: new Date(),
  }), []);

  const handleModelChange = useCallback(
    async (modelId: string, displayName: string) => {
      currentModelIdRef.current = modelId;
      const price = MODEL_OUTPUT_PRICES[modelId];
      const text = price
        ? `Switched to ${displayName} — ${price} output tokens`
        : `Switched to ${displayName}`;
      setMessages((prev) => [...prev, makeSystemMessage(text)]);

      // Persist the switch indicator to DB so it reconstructs on reload
      if (userIdRef.current) {
        const { error: insertErr } = await supabase
          .from("chat_messages")
          .insert({
            session_id: sessionId,
            user_id: userIdRef.current,
            role: "system",
            content: text,
            model: modelId,
          });
        if (insertErr) {
          console.error("Failed to persist model switch:", insertErr);
        }
      }
    },
    [makeSystemMessage, supabase, sessionId]
  );

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

  // Load chat history from Supabase when sessionId changes
  useEffect(() => {
    // Clear stale messages from the previous session immediately
    setMessages([]);
    setCurrentModelLabel(null);
    currentModelLabelRef.current = null;
    currentModelIdRef.current = null;
    isFirstMessageRef.current = true;

    async function loadHistory() {
      const { data, error: queryError } = await supabase
        .from("chat_messages")
        .select("id, role, content, created_at, attachments, model")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (queryError) {
        console.error("Failed to load chat history:", queryError);
        setError("Failed to load conversation history.");
        return;
      }

      // Fetch current model and store user ID
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) userIdRef.current = authUser.id;
      }
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
      let liveModelId: string | null = null;
      if (session && gatewayUrl) {
        const result = await getAvailableModels(gatewayUrl, session.access_token);
        if (result) {
          liveModelId = result.current;
          currentModelIdRef.current = result.current;
        }
      }

      if (data?.length) {
        // Generate signed URLs for image attachments
        const messagesWithUrls = await Promise.all(
          data.map(async (m) => {
            let attachments: MessageAttachment[] | undefined;
            if (m.attachments && Array.isArray(m.attachments)) {
              attachments = await Promise.all(
                (m.attachments as Array<{ name: string; type: string; size: number; storage_path: string }>).map(
                  async (a) => {
                    let url: string | undefined;
                    if (IMAGE_TYPES.has(a.type)) {
                      const { data: signedData } = await supabase.storage
                        .from("chat-attachments")
                        .createSignedUrl(a.storage_path, 3600);
                      url = signedData?.signedUrl;
                    }
                    return { name: a.name, type: a.type, size: a.size, url };
                  }
                )
              );
            }
            return {
              id: m.id,
              role: m.role as "user" | "assistant" | "system",
              content: m.content,
              createdAt: new Date(m.created_at),
              attachments,
            };
          })
        );

        // Determine what model to show at the top of the conversation:
        // Use the first assistant message's model (historical truth), falling back
        // to the live model for old conversations without model data.
        const firstAssistantModel = data.find((m) => m.role === "assistant" && m.model)?.model;
        const topModelId = firstAssistantModel ?? liveModelId;

        let modelSystemMsg: Message | null = null;
        if (topModelId) {
          const name = MODEL_DISPLAY_NAMES[topModelId] ?? topModelId;
          const price = MODEL_OUTPUT_PRICES[topModelId];
          const text = price ? `${name} — ${price} output tokens` : name;
          setCurrentModelLabel(text);
          currentModelLabelRef.current = text;
          modelSystemMsg = {
            id: `system-${crypto.randomUUID()}`,
            role: "system",
            content: text,
            createdAt: new Date(0),
          };
        }

        setMessages(modelSystemMsg ? [modelSystemMsg, ...messagesWithUrls] : messagesWithUrls);
        isFirstMessageRef.current = false;
      } else {
        // New empty session — show live model label and refresh sidebar
        if (liveModelId) {
          const name = MODEL_DISPLAY_NAMES[liveModelId] ?? liveModelId;
          const price = MODEL_OUTPUT_PRICES[liveModelId];
          const text = price ? `${name} — ${price} output tokens` : name;
          setCurrentModelLabel(text);
          currentModelLabelRef.current = text;
        }
        router.refresh();
      }
    }
    loadHistory();
  }, [sessionId, supabase, router]);

  const handleSend = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      setError(null);
      setIsWaking(false);

      // Build optimistic attachments with local preview URLs
      const optimisticAttachments: MessageAttachment[] | undefined =
        attachments?.map((a) => ({
          name: a.name,
          type: a.type,
          size: a.data.length, // approximate
          url: IMAGE_TYPES.has(a.type)
            ? `data:${a.type};base64,${a.data}`
            : undefined,
        }));

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: new Date(),
        attachments: optimisticAttachments,
      };

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        createdAt: new Date(),
      };

      setMessages((prev) => {
        const hasRealMessages = prev.some((m) => m.role !== "system");
        // On first message in a new conversation, prepend the model indicator
        if (!hasRealMessages && currentModelLabelRef.current) {
          const modelMsg = makeSystemMessage(currentModelLabelRef.current);
          return [modelMsg, userMessage, assistantMessage];
        }
        return [...prev, userMessage, assistantMessage];
      });
      setIsStreaming(true);

      // Use getUser() to ensure token freshness, then read session for JWT
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setError("Session expired. Please sign in again.");
        setIsStreaming(false);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        return;
      }
      userIdRef.current = user.id;

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

      // Upload attachments to Supabase Storage in parallel (don't block chat)
      type PersistedAttachment = {
        name: string;
        type: string;
        size: number;
        storage_path: string;
      };
      let persistedAttachments: PersistedAttachment[] | null = null;

      const storageUploadPromise = attachments?.length
        ? (async () => {
            const results: PersistedAttachment[] = [];
            for (const att of attachments) {
              const ext = att.name.split(".").pop() || "bin";
              const storagePath = `${user.id}/${sessionId}/${crypto.randomUUID()}.${ext}`;
              // Convert base64 back to binary for upload
              const bytes = Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0));
              const blob = new Blob([bytes], { type: att.type });
              const { error: uploadErr } = await supabase.storage
                .from("chat-attachments")
                .upload(storagePath, blob, { contentType: att.type });
              if (uploadErr) {
                console.error("Storage upload failed:", uploadErr);
                continue;
              }
              results.push({
                name: att.name,
                type: att.type,
                size: bytes.length,
                storage_path: storagePath,
              });
            }
            persistedAttachments = results.length > 0 ? results : null;
          })()
        : Promise.resolve();

      // Persist user message after storage upload completes (so we have storage paths)
      const persistUserMessage = async () => {
        await storageUploadPromise;
        if (retryCountRef.current === 0) {
          const insertData: Record<string, unknown> = {
            session_id: sessionId,
            user_id: user.id,
            role: "user",
            content,
          };
          if (persistedAttachments) {
            insertData.attachments = persistedAttachments;
          }
          const { error: insertErr } = await supabase
            .from("chat_messages")
            .insert(insertData);
          if (insertErr) {
            console.error("Failed to persist user message:", insertErr);
            setError("Message may not be saved. Check your connection.");
          }
        }
      };

      // Start persistence in background — don't block streaming
      const persistPromise = persistUserMessage();

      let gotContent = false;
      let accumulatedContent = "";

      try {
        for await (const event of streamChat(
          gatewayUrl,
          session.access_token,
          content,
          sessionId,
          attachments
        )) {
          switch (event.type) {
            case "session":
              break;
            case "thinking":
              // Gateway sends the full accumulated thinking text
              // (not a delta), so we replace rather than append.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMessage.id
                    ? { ...m, thinkingContent: event.content }
                    : m
                )
              );
              break;
            case "tool_use": {
              const toolEvent = event.data;
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMessage.id) return m;
                  const existing = m.toolUses ?? [];
                  if (toolEvent.phase === "start") {
                    const entry: ToolUse = {
                      id: toolEvent.toolCallId,
                      name: toolEvent.name,
                      phase: "start",
                      args: toolEvent.args,
                    };
                    return { ...m, toolUses: [...existing, entry] };
                  }
                  // result phase — update existing entry
                  return {
                    ...m,
                    toolUses: existing.map((t) =>
                      t.id === toolEvent.toolCallId
                        ? { ...t, phase: "result" as const, isError: toolEvent.isError }
                        : t
                    ),
                  };
                })
              );
              break;
            }
            case "chunk":
              gotContent = true;
              accumulatedContent += event.content;
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
              if (event.message.includes("stopped")) {
                if (!gotContent) {
                  setMessages((prev) =>
                    prev.filter((m) => m.id !== assistantMessage.id)
                  );
                }
                setError(
                  "Your agent is stopped. Start it from the status badge above."
                );
                setIsStreaming(false);
                return;
              }
              if (event.message.includes("waking up")) {
                if (retryCountRef.current >= MAX_WAKE_RETRIES) {
                  setError(
                    "Agent failed to wake after multiple attempts. Please try again later."
                  );
                  setIsWaking(false);
                  setIsStreaming(false);
                  setMessages((prev) =>
                    prev.filter((m) => m.id !== assistantMessage.id)
                  );
                  return;
                }
                retryCountRef.current += 1;
                setIsWaking(true);
                setMessages((prev) =>
                  prev.filter((m) => m.id !== assistantMessage.id)
                );
                setTimeout(() => {
                  setIsWaking(false);
                  handleSend(content, attachments);
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

      // Wait for user message persistence to complete
      await persistPromise;

      // Persist assistant message to Supabase
      if (accumulatedContent) {
        const { error: insertErr } = await supabase
          .from("chat_messages")
          .insert({
            session_id: sessionId,
            user_id: user.id,
            role: "assistant",
            content: accumulatedContent,
            model: currentModelIdRef.current,
          });
        if (insertErr) {
          console.error("Failed to persist assistant message:", insertErr);
          setError("Response may not be saved. Check your connection.");
        }
      }

      // Touch session to refresh sidebar ordering
      await supabase
        .from("chat_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId);

      // Reset retry counter on successful completion
      retryCountRef.current = 0;

      // Update session title on first message
      if (isFirstMessageRef.current) {
        isFirstMessageRef.current = false;
        const title = content.slice(0, 50);
        await supabase
          .from("chat_sessions")
          .update({ title })
          .eq("id", sessionId);
        router.refresh();
      }
    },
    [sessionId, supabase, router, makeSystemMessage]
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
                Send a message to get started.
              </p>
              {currentModelLabel && (
                <p className="mt-4 text-xs text-muted-foreground">
                  {currentModelLabel}
                </p>
              )}
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

      {isWaking && (
        <div className="mx-auto max-w-3xl w-full px-6">
          <div className="flex items-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-4 py-2.5 text-sm text-yellow-200">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waking your agent... This may take a moment.
          </div>
        </div>
      )}

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

      <ChatInput onSend={handleSend} isStreaming={isStreaming || isWaking} onModelChange={handleModelChange} />
    </div>
  );
}
