"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Edit3,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { createClient } from "@/lib/supabase/client";
import {
  listFiles,
  readFile,
  writeFile,
  createFile,
  deleteFile,
  type FileEntry,
} from "@/lib/gateway";

const ROOT_DIR = "/data/.openclaw/";
const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL!;

type TreeNode = FileEntry & {
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

// ── File Tree Node ────────────────────────────────────────

function TreeNodeItem({
  node,
  depth,
  activeFile,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const isDir = node.type === "directory";
  const isActive = activeFile === node.path;

  return (
    <>
      <button
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
        className={`
          group flex w-full items-center gap-1.5 h-7 text-sm font-mono
          hover:bg-accent/50 transition-colors rounded-sm
          ${isActive ? "bg-accent text-accent-foreground border-l-2 border-primary" : "text-muted-foreground hover:text-foreground border-l-2 border-transparent"}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isDir ? (
          <>
            {node.loading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : node.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            )}
            {node.expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-blue-400/70" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400/70" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5 shrink-0" />
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && node.expanded && node.children?.map((child) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          activeFile={activeFile}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// ── Main Component ────────────────────────────────────────

export function FilesClient({
  machineStatus,
}: {
  machineStatus: string | null;
}) {
  const [jwt, setJwt] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [activeFile, setActiveFile] = useState<TreeNode | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create dialog state
  const [createDialog, setCreateDialog] = useState<{
    open: boolean;
    parentPath: string;
    isDirectory: boolean;
  }>({ open: false, parentPath: ROOT_DIR, isDirectory: false });
  const [createName, setCreateName] = useState("");

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);

  // Unsaved changes dialog
  const [pendingSelect, setPendingSelect] = useState<TreeNode | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDirty = fileContent !== originalContent;
  const isMarkdown = activeFile?.name.endsWith(".md") ?? false;

  // Get JWT on mount
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setJwt(data.session?.access_token ?? null);
    });
  }, []);

  // Load root directory
  const loadDirectory = useCallback(
    async (path: string): Promise<TreeNode[]> => {
      if (!jwt) return [];
      try {
        const res = await listFiles(GATEWAY_URL, jwt, path);
        return res.entries.map((e) => ({
          ...e,
          expanded: false,
          loading: false,
          children: e.type === "directory" ? [] : undefined,
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load directory");
        return [];
      }
    },
    [jwt]
  );

  // Initial load
  useEffect(() => {
    if (!jwt || machineStatus !== "running") {
      setTreeLoading(false);
      return;
    }
    setTreeLoading(true);
    loadDirectory(ROOT_DIR).then((nodes) => {
      setTree(nodes);
      setTreeLoading(false);
    });
  }, [jwt, machineStatus, loadDirectory]);

  // Toggle directory expansion
  const handleToggle = useCallback(
    async (path: string) => {
      const toggleInTree = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.path === path) {
            if (n.expanded) {
              return { ...n, expanded: false };
            }
            return { ...n, expanded: true, loading: true };
          }
          if (n.children) {
            return { ...n, children: toggleInTree(n.children) };
          }
          return n;
        });

      setTree((prev) => toggleInTree(prev));

      // Load children if expanding
      const findNode = (nodes: TreeNode[]): TreeNode | null => {
        for (const n of nodes) {
          if (n.path === path) return n;
          if (n.children) {
            const found = findNode(n.children);
            if (found) return found;
          }
        }
        return null;
      };

      const node = findNode(tree);
      if (node && !node.expanded) {
        const children = await loadDirectory(path);
        setTree((prev) => {
          const updateChildren = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map((n) => {
              if (n.path === path) {
                return { ...n, children, loading: false };
              }
              if (n.children) {
                return { ...n, children: updateChildren(n.children) };
              }
              return n;
            });
          return updateChildren(prev);
        });
      }
    },
    [tree, loadDirectory]
  );

  // Select a file
  const selectFile = useCallback(
    async (node: TreeNode) => {
      if (!jwt) return;
      setActiveFile(node);
      setFileLoading(true);
      setError(null);
      setEditMode(!node.name.endsWith(".md")); // .md defaults to preview

      try {
        const res = await readFile(GATEWAY_URL, jwt, node.path);
        setFileContent(res.content);
        setOriginalContent(res.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to read file");
        setFileContent("");
        setOriginalContent("");
      } finally {
        setFileLoading(false);
      }
    },
    [jwt]
  );

  const handleFileSelect = useCallback(
    (node: TreeNode) => {
      if (isDirty) {
        setPendingSelect(node);
        return;
      }
      selectFile(node);
    },
    [isDirty, selectFile]
  );

  // Save file
  const handleSave = useCallback(async () => {
    if (!jwt || !activeFile) return;
    setSaving(true);
    setError(null);
    try {
      await writeFile(GATEWAY_URL, jwt, activeFile.path, fileContent);
      setOriginalContent(fileContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  }, [jwt, activeFile, fileContent]);

  // Keyboard shortcut: Cmd/Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && activeFile) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, activeFile, handleSave]);

  // Create file/directory
  const handleCreate = useCallback(async () => {
    if (!jwt || !createName.trim()) return;
    const fullPath = `${createDialog.parentPath.replace(/\/$/, "")}/${createName.trim()}`;
    try {
      await createFile(GATEWAY_URL, jwt, fullPath, {
        is_directory: createDialog.isDirectory,
      });
      // Refresh the parent directory
      const children = await loadDirectory(createDialog.parentPath);
      setTree((prev) => {
        if (createDialog.parentPath === ROOT_DIR) return children;
        const update = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.path === createDialog.parentPath.replace(/\/$/, "")) {
              return { ...n, children, expanded: true, loading: false };
            }
            if (n.children) return { ...n, children: update(n.children) };
            return n;
          });
        return update(prev);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    }
    setCreateDialog({ open: false, parentPath: ROOT_DIR, isDirectory: false });
    setCreateName("");
  }, [jwt, createName, createDialog, loadDirectory]);

  // Delete file/directory
  const handleDelete = useCallback(async () => {
    if (!jwt || !deleteTarget) return;
    try {
      await deleteFile(GATEWAY_URL, jwt, deleteTarget.path);
      // Remove from tree
      const removeFromTree = (nodes: TreeNode[]): TreeNode[] =>
        nodes
          .filter((n) => n.path !== deleteTarget.path)
          .map((n) =>
            n.children ? { ...n, children: removeFromTree(n.children) } : n
          );
      setTree((prev) => removeFromTree(prev));
      if (activeFile?.path === deleteTarget.path) {
        setActiveFile(null);
        setFileContent("");
        setOriginalContent("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
    setDeleteTarget(null);
  }, [jwt, deleteTarget, activeFile]);

  // Refresh tree
  const handleRefresh = useCallback(async () => {
    if (!jwt) return;
    setTreeLoading(true);
    const nodes = await loadDirectory(ROOT_DIR);
    setTree(nodes);
    setTreeLoading(false);
  }, [jwt, loadDirectory]);

  // ── Machine not running ─────────────────────────────────

  if (machineStatus !== "running") {
    return (
      <div className="flex h-[calc(100vh-3rem)] items-center justify-center">
        <div className="text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">Agent not running</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Start your agent from the Dashboard to browse and edit files.
          </p>
        </div>
      </div>
    );
  }

  // ── Main Layout ─────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
      {/* ── File Tree (Left Panel) ──────────────────────── */}
      <div className="w-72 shrink-0 border-r border-border bg-muted/30 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Files
          </span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="New file"
              onClick={() =>
                setCreateDialog({ open: true, parentPath: ROOT_DIR, isDirectory: false })
              }
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="New folder"
              onClick={() =>
                setCreateDialog({ open: true, parentPath: ROOT_DIR, isDirectory: true })
              }
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="Refresh"
              onClick={handleRefresh}
              disabled={treeLoading}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${treeLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Tree */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="py-1">
            {treeLoading ? (
              <div className="px-3 py-2 space-y-1.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-6" style={{ marginLeft: i % 2 ? 16 : 0 }} />
                ))}
              </div>
            ) : tree.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-xs text-muted-foreground">No files found</p>
                <Button
                  variant="link"
                  size="sm"
                  className="mt-2 text-xs"
                  onClick={() =>
                    setCreateDialog({ open: true, parentPath: ROOT_DIR, isDirectory: false })
                  }
                >
                  Create a file
                </Button>
              </div>
            ) : (
              tree.map((node) => (
                <TreeNodeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activeFile={activeFile?.path ?? null}
                  onToggle={handleToggle}
                  onSelect={handleFileSelect}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ── Editor (Right Panel) ────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{error}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {activeFile ? (
          <>
            {/* Tab bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/20">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-mono text-muted-foreground truncate">
                  {activeFile.path.replace(ROOT_DIR, "")}
                </span>
                {isDirty && (
                  <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                )}
              </div>
              <div className="flex items-center gap-1">
                {isMarkdown && (
                  <>
                    <Button
                      variant={editMode ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => setEditMode(true)}
                    >
                      <Edit3 className="h-3 w-3" />
                      Edit
                    </Button>
                    <Button
                      variant={!editMode ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => setEditMode(false)}
                    >
                      <Eye className="h-3 w-3" />
                      Preview
                    </Button>
                  </>
                )}
                <Button
                  variant={isDirty ? "default" : "ghost"}
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={handleSave}
                  disabled={!isDirty || saving}
                >
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(activeFile)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Content area */}
            {fileLoading ? (
              <div className="flex-1 p-6 space-y-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : editMode ? (
              <textarea
                ref={textareaRef}
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="flex-1 min-h-0 w-full resize-none bg-[#0d1117] p-4 font-mono text-sm text-foreground focus:outline-none"
                spellCheck={false}
              />
            ) : (
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-6 max-w-3xl">
                  <MarkdownRenderer content={fileContent} />
                </div>
              </ScrollArea>
            )}

            {/* Status bar */}
            {isDirty && (
              <div className="px-4 py-1 border-t border-border bg-muted/20">
                <span className="text-[11px] text-muted-foreground">
                  Unsaved changes — press{" "}
                  <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono border border-border">
                    {navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"}+S
                  </kbd>{" "}
                  to save
                </span>
              </div>
            )}
          </>
        ) : (
          /* No file selected */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <FileText className="h-10 w-10 text-muted-foreground/30 mx-auto" />
              <p className="text-sm text-muted-foreground">
                Select a file to view or edit
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Create Dialog ──────────────────────────────── */}
      <Dialog
        open={createDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setCreateDialog({ open: false, parentPath: ROOT_DIR, isDirectory: false });
            setCreateName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createDialog.isDirectory ? "New Folder" : "New File"}
            </DialogTitle>
            <DialogDescription>
              Create in{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {createDialog.parentPath.replace(ROOT_DIR, "/") || "/"}
              </code>
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={createDialog.isDirectory ? "folder-name" : "filename.md"}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateDialog({ open: false, parentPath: ROOT_DIR, isDirectory: false });
                setCreateName("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!createName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ─────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.type === "directory" ? "folder" : "file"}?</DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {deleteTarget?.name}
              </code>
              {deleteTarget?.type === "directory" && " and all its contents"}.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Unsaved Changes Confirmation ────────────────── */}
      <Dialog open={!!pendingSelect} onOpenChange={() => setPendingSelect(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes to{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {activeFile?.name}
              </code>
              . Discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSelect(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingSelect) {
                  selectFile(pendingSelect);
                  setPendingSelect(null);
                }
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
