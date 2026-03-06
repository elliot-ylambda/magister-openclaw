import { checkAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EmailClient } from "./email-client";

export default async function EmailPage() {
  const { user } = await checkAccess();
  const supabase = await createClient();

  const { data: machine } = await supabase
    .from("user_machines_safe")
    .select("email_address")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  return <EmailClient agentEmail={machine?.email_address ?? null} />;
}
