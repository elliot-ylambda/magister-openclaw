import { createClient } from "@/lib/supabase/server";
import { checkAccess } from "@/lib/auth";
import { FilesClient } from "./files-client";

export default async function FilesPage() {
  const { user } = await checkAccess();

  const supabase = await createClient();
  const { data: machine } = await supabase
    .from("user_machines_safe")
    .select("status")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  return <FilesClient machineStatus={machine?.status ?? null} />;
}
