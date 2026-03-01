import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ChatPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Always create a fresh session for "New Chat"
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
