import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ChatPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Reuse the most recent empty session (still has default title, no messages sent)
  // to prevent duplicate sessions from cross-layout redirects (e.g. checkout → chat)
  const { data: emptySession } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("user_id", user.id)
    .eq("title", "New conversation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (emptySession) {
    redirect(`/chat/${emptySession.id}`);
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
