import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ChatPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Find most recent session or create a new one
  const { data: existing } = await supabase
    .from("chat_sessions")
    .select("id")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    redirect(`/chat/${existing.id}`);
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
