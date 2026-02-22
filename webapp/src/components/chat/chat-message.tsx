"use client";

import dynamic from "next/dynamic";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

const MarkdownRenderer = dynamic(
  () =>
    import("./markdown-renderer").then((mod) => mod.MarkdownRenderer),
  {
    loading: () => (
      <div className="animate-pulse text-sm text-muted-foreground">
        Rendering...
      </div>
    ),
  }
);

export function ChatMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] sm:max-w-[75%] ${
          isUser
            ? "rounded-2xl rounded-br-md bg-muted px-4 py-2.5"
            : "prose-sm"
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="text-sm">
            {message.content ? (
              <MarkdownRenderer content={message.content} />
            ) : isStreaming ? (
              <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground rounded-sm" />
            ) : null}
            {isStreaming && message.content && (
              <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground rounded-sm ml-0.5 align-text-bottom" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
