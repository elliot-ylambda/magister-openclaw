import Link from "next/link";
import { redirect } from "next/navigation";
import { Shield } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { checkAccess } from "@/lib/auth";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/shared/app-sidebar";
import { AgentStatusBadge } from "@/components/chat/agent-status-badge";
import { UserNav } from "@/components/shared/user-nav";
import { Separator } from "@/components/ui/separator";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile, isAdmin, hasAccess } = await checkAccess();

  if (!hasAccess) {
    redirect("/pricing");
  }

  // Fetch chat sessions for sidebar
  const supabase = await createClient();
  const { data: sessions } = await supabase
    .from("chat_sessions")
    .select("id, title, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  const displayName =
    profile?.display_name ??
    (user.user_metadata?.full_name as string) ??
    null;

  return (
    <SidebarProvider>
      <AppSidebar sessions={sessions ?? []} />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-2" />
          <Separator orientation="vertical" className="h-4" />
          <div className="flex-1" />
          {isAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Shield className="h-3.5 w-3.5" />
              Admin
            </Link>
          )}
          <AgentStatusBadge />
          <UserNav email={user.email ?? null} displayName={displayName} />
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
