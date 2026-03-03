"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowUp, Paperclip, X, FileText, Image as ImageIcon } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { Attachment } from "@/lib/gateway";

const MAX_ROWS = 5;
const LINE_HEIGHT = 24;
const PADDING = 16;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const FILE_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
]);
const ALL_ACCEPT = [...IMAGE_TYPES, ...FILE_TYPES].join(",");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

type PendingFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string; // base64 (no prefix)
  previewUrl?: string; // data URL for image thumbnails
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:...;base64, prefix
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatInput({
  onSend,
  isStreaming,
}: {
  onSend: (message: string, attachments?: Attachment[]) => void;
  isStreaming: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    setFileError(null);
    const files = Array.from(fileList);

    for (const file of files) {
      const isImage = IMAGE_TYPES.has(file.type);
      const isFile = FILE_TYPES.has(file.type);

      if (!isImage && !isFile) {
        setFileError(`Unsupported file type: ${file.type || file.name}`);
        continue;
      }

      const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size > maxBytes) {
        setFileError(
          `${file.name} is too large (${formatFileSize(file.size)}). Max: ${formatFileSize(maxBytes)}`
        );
        continue;
      }

      try {
        const data = await readFileAsBase64(file);
        const previewUrl = isImage ? `data:${file.type};base64,${data}` : undefined;
        setPendingFiles((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            size: file.size,
            data,
            previewUrl,
          },
        ]);
      } catch {
        setFileError(`Failed to read ${file.name}`);
      }
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value.trim();
    if ((!value && pendingFiles.length === 0) || isStreaming) return;

    const attachments: Attachment[] | undefined =
      pendingFiles.length > 0
        ? pendingFiles.map((f) => ({ name: f.name, type: f.type, data: f.data }))
        : undefined;

    onSend(value, attachments);
    el.value = "";
    el.style.height = "auto";
    setPendingFiles([]);
    setFileError(null);
  }, [onSend, isStreaming, pendingFiles]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  return (
    <div className="sticky bottom-0 border-t bg-background p-4">
      <div
        className={`relative mx-auto max-w-3xl rounded-xl border transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-transparent"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File error */}
        {fileError && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-1.5 text-xs text-red-300">
            <span className="flex-1">{fileError}</span>
            <button onClick={() => setFileError(null)} className="text-red-400 hover:text-red-200">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* File preview strip */}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {pendingFiles.map((file) => (
              <div
                key={file.id}
                className="group relative flex items-center gap-2 rounded-lg border bg-muted/50 px-2.5 py-1.5"
              >
                {file.previewUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={file.previewUrl}
                    alt={file.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground" />
                )}
                <div className="flex flex-col">
                  <span className="max-w-[120px] truncate text-xs font-medium">
                    {file.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                </div>
                <button
                  onClick={() => removeFile(file.id)}
                  className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div className="relative">
          <Textarea
            ref={textareaRef}
            autoFocus
            onInput={adjustHeight}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isStreaming}
            placeholder={
              isStreaming ? "Agent is working..." : "Send a message..."
            }
            className="min-h-[48px] resize-none pl-11 pr-12 rounded-xl"
            rows={1}
          />
          {/* Paperclip button */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            className="absolute left-2 bottom-2 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          {/* Send button */}
          <Button
            size="icon-sm"
            onClick={handleSend}
            disabled={isStreaming}
            className="absolute right-2 bottom-2 rounded-lg"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALL_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Drag overlay hint */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <ImageIcon className="h-5 w-5" />
              Drop files here
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
