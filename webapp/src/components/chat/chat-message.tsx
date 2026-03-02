"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { Check, Copy, FileText } from "lucide-react";

export interface MessageAttachment {
  name: string;
  type: string;
  size: number;
  url?: string; // Supabase signed URL or local data URL
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  attachments?: MessageAttachment[];
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function AttachmentDisplay({ attachments }: { attachments: MessageAttachment[] }) {
  const images = attachments.filter((a) => IMAGE_TYPES.has(a.type) && a.url);
  const files = attachments.filter((a) => !IMAGE_TYPES.has(a.type) || !a.url);

  return (
    <div className="space-y-2">
      {/* Image thumbnails */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <a
              key={i}
              href={img.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-lg border border-border/50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.name}
                className="max-h-[200px] max-w-[280px] object-contain"
              />
            </a>
          ))}
        </div>
      )}
      {/* File pills */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1"
            >
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[150px] truncate text-xs">{file.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {formatFileSize(file.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatMessage({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming?: boolean;
}) {
  const isUser = message.role === "user";
  const hasAttachments = message.attachments && message.attachments.length > 0;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in insecure contexts
    }
  }, [message.content]);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] sm:max-w-[75%] ${
          isUser
            ? "rounded-2xl rounded-br-md bg-muted px-4 py-2.5"
            : "group relative prose-sm"
        }`}
      >
        {isUser ? (
          <div className="space-y-2">
            {hasAttachments && (
              <AttachmentDisplay attachments={message.attachments!} />
            )}
            {message.content && (
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
            )}
          </div>
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
        {!isUser && !isStreaming && message.content && (
          <button
            onClick={handleCopy}
            className="absolute right-0 top-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
