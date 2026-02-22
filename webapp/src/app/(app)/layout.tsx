import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Subscription guard: check for active subscription
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!subscription) {
    redirect("/pricing");
  }

  // Fetch chat sessions for sidebar
  const { data: sessions } = await supabase
    .from("chat_sessions")
    .select("id, title, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  // Get display name from profile or user metadata
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .single();

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
          <AgentStatusBadge />
          <UserNav email={user.email ?? null} displayName={displayName} />
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
