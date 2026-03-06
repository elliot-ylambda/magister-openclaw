"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Loader2,
  Mail,
  MailOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import DOMPurify from "dompurify";
import { Badge } from "@/components/ui/badge";
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
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import {
  approveEmail,
  editAndSendEmail,
  getEmailInbox,
  getPendingEmails,
  getSentEmails,
  rejectEmail,
  rewriteEmail,
  type AgentEmail,
} from "@/lib/gateway";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL!;

// ── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  sent: "secondary",
  received: "secondary",
  rejected: "destructive",
  failed: "destructive",
  quarantined: "destructive",
  rewrite_requested: "outline",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Main Component ───────────────────────────────────────────

export function EmailClient({ agentEmail }: { agentEmail: string | null }) {
  const [activeTab, setActiveTab] = useState<"pending" | "inbox" | "sent">("pending");
  const [emails, setEmails] = useState<AgentEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEmail, setSelectedEmail] = useState<AgentEmail | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [rewriteMode, setRewriteMode] = useState(false);
  const [editedSubject, setEditedSubject] = useState("");
  const [editedBody, setEditedBody] = useState("");
  const [rewriteNote, setRewriteNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // ── JWT ──────────────────────────────────────────────────

  const getJwt = useCallback(async (): Promise<string | null> => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  // ── Fetch emails ─────────────────────────────────────────

  const fetchEmails = useCallback(async () => {
    const jwt = await getJwt();
    if (!jwt) return;

    setLoading(true);
    try {
      let result: { emails: AgentEmail[] };
      switch (activeTab) {
        case "pending":
          result = await getPendingEmails(GATEWAY_URL, jwt);
          break;
        case "inbox":
          result = await getEmailInbox(GATEWAY_URL, jwt);
          break;
        case "sent":
          result = await getSentEmails(GATEWAY_URL, jwt);
          break;
      }
      setEmails(result.emails);
    } catch {
      setEmails([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, getJwt]);

  useEffect(() => {
    if (!agentEmail) {
      setLoading(false);
      return;
    }
    fetchEmails();
  }, [activeTab, agentEmail, fetchEmails]);

  // ── Actions ──────────────────────────────────────────────

  const handleApprove = useCallback(async () => {
    if (!selectedEmail) return;
    const jwt = await getJwt();
    if (!jwt) return;
    setActionLoading(true);
    try {
      await approveEmail(GATEWAY_URL, jwt, selectedEmail.id);
      setSheetOpen(false);
      setSelectedEmail(null);
      await fetchEmails();
    } finally {
      setActionLoading(false);
    }
  }, [selectedEmail, getJwt, fetchEmails]);

  const handleReject = useCallback(async () => {
    if (!selectedEmail) return;
    const jwt = await getJwt();
    if (!jwt) return;
    setActionLoading(true);
    try {
      await rejectEmail(GATEWAY_URL, jwt, selectedEmail.id);
      setRejectDialogOpen(false);
      setSheetOpen(false);
      setSelectedEmail(null);
      await fetchEmails();
    } finally {
      setActionLoading(false);
    }
  }, [selectedEmail, getJwt, fetchEmails]);

  const handleRewriteSubmit = useCallback(async () => {
    if (!selectedEmail || !rewriteNote.trim()) return;
    const jwt = await getJwt();
    if (!jwt) return;
    setActionLoading(true);
    try {
      await rewriteEmail(GATEWAY_URL, jwt, selectedEmail.id, rewriteNote);
      setRewriteMode(false);
      setRewriteNote("");
      setSheetOpen(false);
      setSelectedEmail(null);
      await fetchEmails();
    } finally {
      setActionLoading(false);
    }
  }, [selectedEmail, rewriteNote, getJwt, fetchEmails]);

  const handleEditSend = useCallback(async () => {
    if (!selectedEmail) return;
    const jwt = await getJwt();
    if (!jwt) return;
    setActionLoading(true);
    try {
      await editAndSendEmail(GATEWAY_URL, jwt, selectedEmail.id, {
        subject: editedSubject,
        body_text: editedBody,
      });
      setEditMode(false);
      setSheetOpen(false);
      setSelectedEmail(null);
      await fetchEmails();
    } finally {
      setActionLoading(false);
    }
  }, [selectedEmail, editedSubject, editedBody, getJwt, fetchEmails]);

  const openEmail = useCallback((email: AgentEmail) => {
    setSelectedEmail(email);
    setEditMode(false);
    setRewriteMode(false);
    setRewriteNote("");
    setEditedSubject(email.subject);
    setEditedBody(email.body_text ?? "");
    setSheetOpen(true);
  }, []);

  const handleCopyEmail = useCallback(async () => {
    if (!agentEmail) return;
    await navigator.clipboard.writeText(agentEmail);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [agentEmail]);

  // ── No agent email ────────────────────────────────────────

  if (!agentEmail) {
    return (
      <div className="flex h-[calc(100vh-3rem)] items-center justify-center">
        <div className="text-center space-y-3">
          <Mail className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">No email address assigned</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Your agent will get an email address when provisioned.
          </p>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Email</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground font-mono">{agentEmail}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopyEmail}
            title="Copy email address"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "pending" | "inbox" | "sent")}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="px-6 pt-4">
          <TabsList>
            <TabsTrigger value="pending" className="gap-1.5">
              <MailOpen className="h-3.5 w-3.5" />
              Pending
              {!loading && activeTab === "pending" && emails.length > 0 && (
                <Badge variant="default" className="ml-1 h-5 min-w-5 text-[10px]">
                  {emails.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="inbox" className="gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Inbox
            </TabsTrigger>
            <TabsTrigger value="sent" className="gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Sent
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Tab content */}
        <TabsContent value="pending" className="flex-1 min-h-0">
          <EmailList
            emails={emails}
            loading={loading}
            tab="pending"
            onSelect={openEmail}
            onRefresh={fetchEmails}
          />
        </TabsContent>
        <TabsContent value="inbox" className="flex-1 min-h-0">
          <EmailList
            emails={emails}
            loading={loading}
            tab="inbox"
            onSelect={openEmail}
            onRefresh={fetchEmails}
          />
        </TabsContent>
        <TabsContent value="sent" className="flex-1 min-h-0">
          <EmailList
            emails={emails}
            loading={loading}
            tab="sent"
            onSelect={openEmail}
            onRefresh={fetchEmails}
          />
        </TabsContent>
      </Tabs>

      {/* Email detail sheet */}
      <Sheet open={sheetOpen} onOpenChange={(open) => {
        setSheetOpen(open);
        if (!open) {
          setEditMode(false);
          setRewriteMode(false);
        }
      }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-lg md:max-w-xl lg:max-w-2xl flex flex-col"
        >
          {selectedEmail && (
            <>
              <SheetHeader className="space-y-3">
                <div className="flex items-start justify-between gap-4 pr-6">
                  {editMode ? (
                    <Input
                      value={editedSubject}
                      onChange={(e) => setEditedSubject(e.target.value)}
                      className="text-lg font-semibold"
                    />
                  ) : (
                    <SheetTitle className="text-base leading-tight">
                      {selectedEmail.subject}
                    </SheetTitle>
                  )}
                  <Badge variant={STATUS_VARIANT[selectedEmail.status] ?? "outline"}>
                    {statusLabel(selectedEmail.status)}
                  </Badge>
                </div>
                <SheetDescription className="space-y-1 text-xs">
                  <span className="block">
                    <span className="text-muted-foreground">From: </span>
                    <span className="text-foreground">{selectedEmail.from_address}</span>
                  </span>
                  <span className="block">
                    <span className="text-muted-foreground">To: </span>
                    <span className="text-foreground">{selectedEmail.to_address}</span>
                  </span>
                  {selectedEmail.cc && selectedEmail.cc.length > 0 && (
                    <span className="block">
                      <span className="text-muted-foreground">CC: </span>
                      <span className="text-foreground">{selectedEmail.cc.join(", ")}</span>
                    </span>
                  )}
                  <span className="block">
                    <span className="text-muted-foreground">Date: </span>
                    <span className="text-foreground">
                      {new Date(selectedEmail.created_at).toLocaleString()}
                    </span>
                  </span>
                </SheetDescription>
              </SheetHeader>

              <Separator />

              {/* Quarantine warning */}
              {selectedEmail.status === "quarantined" && selectedEmail.scan_result && (
                <div className="mx-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-destructive">Email quarantined</p>
                    <p className="text-muted-foreground text-xs mt-1">
                      This email was flagged by the security scan.
                      {typeof selectedEmail.scan_result === "object" &&
                        "reason" in selectedEmail.scan_result &&
                        ` Reason: ${String(selectedEmail.scan_result.reason)}`}
                    </p>
                  </div>
                </div>
              )}

              {/* Body */}
              <ScrollArea className="flex-1 min-h-0">
                <div className="p-4">
                  {editMode ? (
                    <Textarea
                      value={editedBody}
                      onChange={(e) => setEditedBody(e.target.value)}
                      className="min-h-[300px] font-mono text-sm"
                      placeholder="Email body..."
                    />
                  ) : selectedEmail.body_html ? (
                    <div
                      className="prose prose-invert prose-sm max-w-none [&_a]:text-primary [&_img]:max-w-full"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(selectedEmail.body_html),
                      }}
                    />
                  ) : selectedEmail.body_text ? (
                    <pre className="whitespace-pre-wrap text-sm text-foreground font-mono">
                      {selectedEmail.body_text}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No body content</p>
                  )}
                </div>
              </ScrollArea>

              {/* Rewrite mode input */}
              {rewriteMode && (
                <div className="mx-4 space-y-2">
                  <Separator />
                  <label className="text-sm font-medium">Rewrite instructions</label>
                  <Textarea
                    value={rewriteNote}
                    onChange={(e) => setRewriteNote(e.target.value)}
                    placeholder="Tell the agent how to rewrite this email..."
                    className="min-h-[80px] text-sm"
                    autoFocus
                  />
                </div>
              )}

              {/* Actions — only for pending emails */}
              {selectedEmail.status === "pending" && (
                <div className="border-t border-border p-4">
                  {editMode ? (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handleEditSend}
                        disabled={actionLoading}
                        className="gap-1.5"
                      >
                        {actionLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Save & Send
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setEditMode(false);
                          setEditedSubject(selectedEmail.subject);
                          setEditedBody(selectedEmail.body_text ?? "");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : rewriteMode ? (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handleRewriteSubmit}
                        disabled={actionLoading || !rewriteNote.trim()}
                        className="gap-1.5"
                      >
                        {actionLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Submit
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setRewriteMode(false);
                          setRewriteNote("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        onClick={handleApprove}
                        disabled={actionLoading}
                        className="gap-1.5"
                      >
                        {actionLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setEditMode(true)}
                        className="gap-1.5"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit & Send
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setRewriteMode(true)}
                        className="gap-1.5"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Request Rewrite
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => setRejectDialogOpen(true)}
                        disabled={actionLoading}
                        className="gap-1.5"
                      >
                        <X className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Reject confirmation dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject email?</DialogTitle>
            <DialogDescription>
              This will prevent the email from being sent. The agent will be notified
              that the email was rejected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={actionLoading}
              className="gap-1.5"
            >
              {actionLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Email List Sub-component ─────────────────────────────────

function EmailList({
  emails,
  loading,
  tab,
  onSelect,
  onRefresh,
}: {
  emails: AgentEmail[];
  loading: boolean;
  tab: "pending" | "inbox" | "sent";
  onSelect: (email: AgentEmail) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-2">
        <span className="text-xs text-muted-foreground">
          {loading ? "Loading..." : `${emails.length} email${emails.length !== 1 ? "s" : ""}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Email list */}
      <ScrollArea className="flex-1 min-h-0 px-6 pb-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Mail className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No emails</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {tab === "pending"
                ? "No emails waiting for your approval"
                : tab === "inbox"
                  ? "No received emails yet"
                  : "No sent emails yet"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {emails.map((email) => (
              <button
                key={email.id}
                onClick={() => onSelect(email)}
                className="w-full text-left rounded-lg border border-border hover:bg-accent/50 transition-colors cursor-pointer p-4 space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant={STATUS_VARIANT[email.status] ?? "outline"}
                      className="text-[10px] shrink-0"
                    >
                      {statusLabel(email.status)}
                    </Badge>
                    <span className="text-sm text-muted-foreground truncate">
                      {tab === "sent" || email.direction === "outbound"
                        ? `To: ${email.to_address}`
                        : `From: ${email.from_address}`}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground/60 shrink-0">
                    {formatDate(email.created_at)}
                  </span>
                </div>
                <p className="text-sm font-medium truncate">
                  {email.subject || "(No subject)"}
                </p>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
