"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { AlertCircle, Brain, Check, ChevronDown, Copy, FileText, Loader2 } from "lucide-react";

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
  errorContent?: string;
  args?: Record<string, unknown>;
  startedAt?: number;
  durationMs?: number;
}

export type ContentBlock =
  | { type: "thinking"; content: string; durationMs?: number }
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: ToolUse };

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
  attachments?: MessageAttachment[];
  thinkingContent?: string;
  thinkingDurationMs?: number;
  toolUses?: ToolUse[];
  contentBlocks?: ContentBlock[];
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

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function ThinkingBlock({
  content,
  isStreaming,
  durationMs,
}: {
  content: string;
  isStreaming?: boolean;
  durationMs?: number;
}) {
  return (
    <details className="mb-2 group/thinking">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
        {durationMs != null && (
          <span className="text-muted-foreground/60">{formatDuration(durationMs)}</span>
        )}
        <ChevronDown className="h-3 w-3 transition-transform group-open/thinking:rotate-180" />
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

function toolFullDetail(tool: ToolUse): string | null {
  const args = tool.args;
  if (!args || Object.keys(args).length === 0) return null;

  if (tool.name === "exec" || tool.name === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    return cmd || null;
  }

  // For other tools, show all args as key: value pairs
  return Object.entries(args)
    .map(([key, value]) => {
      const val = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `${key}: ${val}`;
    })
    .join("\n");
}

function ToolUseBadge({ tool, isExpanded, onToggle }: { tool: ToolUse; isExpanded: boolean; onToggle: () => void }) {
  const detail = toolFullDetail(tool);
  return (
    <div className="w-fit">
      <button
        type="button"
        onClick={detail ? onToggle : undefined}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground font-mono ${detail ? "cursor-pointer hover:bg-muted/40" : "cursor-default"}`}
      >
        {tool.phase === "start" ? (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        ) : tool.isError ? (
          <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
        ) : (
          <Check className="h-3 w-3 text-green-400 shrink-0" />
        )}
        <span className="truncate max-w-[300px]">{toolDisplayLabel(tool)}</span>
        {tool.durationMs != null && (
          <span className="text-muted-foreground/60 ml-1">{formatDuration(tool.durationMs)}</span>
        )}
        {detail && (
          <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
        )}
      </button>
      {isExpanded && detail && (
        <pre className="mt-1 ml-2 rounded-md bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
          {detail}
        </pre>
      )}
      {tool.isError && tool.errorContent && (
        <div className="mt-1 ml-2 rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-[11px] text-red-400 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
          {tool.errorContent}
        </div>
      )}
    </div>
  );
}

function ToolUseBadges({ tools }: { tools: ToolUse[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="mb-2 flex flex-col gap-1">
      {tools.map((tool) => (
        <ToolUseBadge
          key={tool.id}
          tool={tool}
          isExpanded={expandedIds.has(tool.id)}
          onToggle={() => toggleExpand(tool.id)}
        />
      ))}
    </div>
  );
}

function ChronologicalBlocks({
  blocks,
  isStreaming,
}: {
  blocks: ContentBlock[];
  isStreaming?: boolean;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const lastBlock = blocks[blocks.length - 1];
  const hasContent = blocks.some((b) => b.type === "text" && b.content);

  return (
    <div className="text-sm">
      {blocks.map((block, i) => {
        const isLast = i === blocks.length - 1;
        switch (block.type) {
          case "thinking":
            return (
              <ThinkingBlock
                key={`thinking-${i}`}
                content={block.content}
                isStreaming={isStreaming && isLast && !hasContent}
                durationMs={block.durationMs}
              />
            );
          case "tool_use":
            return (
              <div key={block.tool.id} className="my-1 flex flex-col gap-1">
                <ToolUseBadge
                  tool={block.tool}
                  isExpanded={expandedIds.has(block.tool.id)}
                  onToggle={() => toggleExpand(block.tool.id)}
                />
              </div>
            );
          case "text":
            return block.content ? (
              <div key={`text-${i}`}>
                <MarkdownRenderer content={block.content} />
                {isStreaming && isLast && (
                  <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground rounded-sm ml-0.5 align-text-bottom" />
                )}
              </div>
            ) : null;
        }
      })}
      {isStreaming && !hasContent && lastBlock?.type !== "thinking" && (
        <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground rounded-sm" />
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
            ? "group relative rounded-2xl rounded-br-md bg-muted px-4 py-2.5"
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
        ) : message.contentBlocks && message.contentBlocks.length > 0 ? (
          <ChronologicalBlocks
            blocks={message.contentBlocks}
            isStreaming={isStreaming}
          />
        ) : (
          <div className="text-sm">
            {message.thinkingContent && (
              <ThinkingBlock
                content={message.thinkingContent}
                isStreaming={isStreaming && !message.content}
                durationMs={message.thinkingDurationMs}
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
        {!isStreaming && message.content && (
          <button
            onClick={handleCopy}
            className={`absolute rounded-md p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 ${
              isUser ? "left-0 top-0 -translate-x-full -ml-1" : "right-0 top-0"
            }`}
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
