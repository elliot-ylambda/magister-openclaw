"use server";

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function insertWaitlistEmail(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.from("waitlist").insert({
    email: email.toLowerCase().trim(),
  });

  if (error) {
    console.error("Supabase insert error:", error);
    if (error.code === "23505") {
      return { success: false, error: "This email is already on the waitlist." };
    }
    return { success: false, error: "Something went wrong. Please try again." };
  }

  return { success: true };
}

export async function updateWaitlistSurvey(
  email: string,
  data: {
    roles?: string[];
    experience?: string[];
    ai_providers?: string[];
    channels?: string[];
    use_cases?: string[];
  }
): Promise<{ success: boolean; error?: string }> {
  const updates: Record<string, string[]> = {};
  if (data.roles) updates.roles = data.roles;
  if (data.experience) updates.experience = data.experience;
  if (data.ai_providers) updates.ai_providers = data.ai_providers;
  if (data.channels) updates.channels = data.channels;
  if (data.use_cases) updates.use_cases = data.use_cases;

  const { error } = await supabase
    .from("waitlist")
    .update(updates)
    .eq("email", email.toLowerCase().trim());

  if (error) {
    console.error("Supabase update error:", error);
    return { success: false, error: "Something went wrong. Please try again." };
  }

  return { success: true };
}
