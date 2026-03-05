import { checkAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SkillsClient } from "./skills-client";

export default async function SkillsPage() {
  const { user } = await checkAccess();
  const supabase = await createClient();
  const { data: machine } = await supabase
    .from("user_machines_safe")
    .select("status")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  return <SkillsClient machineStatus={machine?.status ?? null} />;
}
