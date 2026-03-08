import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ChatPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Reuse the most recent empty session to prevent duplicate sessions from
  // cross-layout redirects (e.g. checkout → chat). We check for zero messages
  // rather than relying on the title, since the title update is deferred until
  // after streaming completes and could race with a "New Chat" click.
  const { data: candidates } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("user_id", user.id)
    .eq("title", "New conversation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (candidates) {
    const { count } = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("session_id", candidates.id);

    if (count === 0) {
      redirect(`/chat/${candidates.id}`);
    }
  }

  const { data: session } = await supabase
    .from("chat_sessions")
    .insert({ user_id: user.id })
    .select("id")
    .single();

  if (!session) {
    throw new Error("Failed to create chat session");
  }

  redirect(`/chat/${session.id}`);
}
