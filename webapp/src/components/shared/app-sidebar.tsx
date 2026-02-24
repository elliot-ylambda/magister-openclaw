"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  MessageSquarePlus,
  Trash2,
  LayoutDashboard,
  Settings,
  MessageSquare,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ScrollArea } from "@/components/ui/scroll-area";

type ChatSession = {
  id: string;
  title: string;
  updated_at: string;
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function AppSidebar({
  sessions: initialSessions,
}: {
  sessions: ChatSession[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [sessions, setSessions] = useState(initialSessions);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Sync server-fetched sessions when layout re-renders (e.g. after router.refresh())
  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  const activeSessionId = pathname.startsWith("/chat/")
    ? pathname.split("/")[2]
    : null;

  const handleDelete = async () => {
    if (!deleteId) return;
    await supabase.from("chat_sessions").delete().eq("id", deleteId);
    setSessions((prev) => prev.filter((s) => s.id !== deleteId));
    setDeleteId(null);
    if (activeSessionId === deleteId) {
      router.push("/chat");
    }
  };

  return (
    <>
      <Sidebar>
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <img
              src="/magister-logo-white.svg"
              alt="Magister"
              className="h-5 w-5"
            />
            <span className="text-sm font-semibold tracking-tight">
              Magister
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => router.push("/chat")}
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Chat
          </Button>
        </SidebarHeader>

        <SidebarContent>
          <ScrollArea className="flex-1">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {sessions.length === 0 ? (
                    <p className="px-4 py-8 text-xs text-muted-foreground text-center">
                      No conversations yet.
                      <br />
                      Start a new chat!
                    </p>
                  ) : (
                    sessions.map((session) => (
                      <SidebarMenuItem key={session.id}>
                        <SidebarMenuButton
                          isActive={activeSessionId === session.id}
                          onClick={() => router.push(`/chat/${session.id}`)}
                        >
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm flex-1">
                            {session.title.length > 40
                              ? session.title.slice(0, 40) + "..."
                              : session.title}
                          </span>
                          <span className="text-[10px] text-muted-foreground group-hover/menu-item:opacity-0 transition-opacity">
                            {formatRelativeTime(session.updated_at)}
                          </span>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          showOnHover
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteId(session.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    ))
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </ScrollArea>
        </SidebarContent>

        <SidebarFooter className="p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => router.push("/dashboard")}
                className="gap-2"
              >
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => router.push("/settings")}
                className="gap-2"
              >
                <Settings className="h-4 w-4" />
                Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete conversation?</DialogTitle>
            <DialogDescription>
              This will permanently delete this conversation from your sidebar.
              Message history on your agent is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
