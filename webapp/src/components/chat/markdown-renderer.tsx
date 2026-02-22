"use client";

import { memo, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

function CopyButton({ getCode }: { getCode: () => string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getCode());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in insecure contexts
    }
  }, [getCode]);

  return (
    <button
      onClick={handleCopy}
      className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function PreBlock({
  children,
  ...props
}: React.ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const getCode = useCallback(
    () => preRef.current?.textContent ?? "",
    []
  );

  return (
    <div className="group relative my-3">
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-lg border bg-[#0d1117] p-4 text-sm"
        {...props}
      >
        {children}
      </pre>
      <CopyButton getCode={getCode} />
    </div>
  );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: PreBlock,
        code({ className, children, ...props }) {
          const isBlock =
            className?.startsWith("hljs") ||
            className?.includes("language-");
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code
              className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono"
              {...props}
            >
              {children}
            </code>
          );
        },
        a({ href, children, ...props }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
              {...props}
            >
              {children}
            </a>
          );
        },
        table({ children, ...props }) {
          return (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm" {...props}>
                {children}
              </table>
            </div>
          );
        },
        th({ children, ...props }) {
          return (
            <th
              className="border border-border px-3 py-2 text-left font-medium"
              {...props}
            >
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td className="border border-border px-3 py-2" {...props}>
              {children}
            </td>
          );
        },
        ul({ children, ...props }) {
          return (
            <ul className="my-2 ml-6 list-disc space-y-1" {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="my-2 ml-6 list-decimal space-y-1" {...props}>
              {children}
            </ol>
          );
        },
        p({ children, ...props }) {
          return (
            <p className="my-2 leading-relaxed" {...props}>
              {children}
            </p>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1 className="mt-6 mb-2 text-xl font-bold" {...props}>
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2 className="mt-5 mb-2 text-lg font-semibold" {...props}>
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3 className="mt-4 mb-2 text-base font-semibold" {...props}>
              {children}
            </h3>
          );
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="my-3 border-l-2 border-muted-foreground/30 pl-4 italic text-muted-foreground"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        hr(props) {
          return <hr className="my-4 border-border" {...props} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});
