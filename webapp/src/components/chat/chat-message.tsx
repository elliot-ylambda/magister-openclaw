"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { AlertCircle, Brain, Check, Copy, FileText, Loader2 } from "lucide-react";

export interface MessageAttachment {
  name: string;
  type: string;
  size: number;
  url?: string; // Supabase signed URL or local data URL
}

export interface ToolUse {
  id: string;
  name: string;
  phase: "start" | "result";
  isError?: boolean;
  args?: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
  attachments?: MessageAttachment[];
  thinkingContent?: string;
  toolUses?: ToolUse[];
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

function ThinkingBlock({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <details className="mb-2 group/thinking">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
      </summary>
      <div className="mt-1 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
        {content}
        {isStreaming && (
          <span className="inline-block h-3 w-1 animate-pulse bg-muted-foreground rounded-sm ml-0.5 align-text-bottom" />
        )}
      </div>
    </details>
  );
}

function toolDisplayLabel(tool: ToolUse): string {
  const args = tool.args;
  if (!args) return tool.name;

  // Show a meaningful summary based on tool type
  if (tool.name === "exec" || tool.name === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    if (cmd) return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
  }
  if (tool.name === "read") {
    const path = typeof args.path === "string" ? args.path : "";
    if (path) return `read ${path}`;
  }
  if (tool.name === "write" || tool.name === "edit") {
    const path = typeof args.path === "string" ? args.path : "";
    if (path) return `${tool.name} ${path}`;
  }
  return tool.name;
}

function ToolUseBadges({ tools }: { tools: ToolUse[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {tools.map((tool) => (
        <span
          key={tool.id}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground font-mono"
        >
          {tool.phase === "start" ? (
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          ) : tool.isError ? (
            <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
          ) : (
            <Check className="h-3 w-3 text-green-400 shrink-0" />
          )}
          <span className="truncate max-w-[300px]">{toolDisplayLabel(tool)}</span>
        </span>
      ))}
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

  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="h-px flex-1 bg-border" />
        <span className="shrink-0 text-xs text-muted-foreground">{message.content}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  const isUser = message.role === "user";
  const hasAttachments = message.attachments && message.attachments.length > 0;

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
            {message.thinkingContent && (
              <ThinkingBlock
                content={message.thinkingContent}
                isStreaming={isStreaming && !message.content}
              />
            )}
            {message.toolUses && message.toolUses.length > 0 && (
              <ToolUseBadges tools={message.toolUses} />
            )}
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
