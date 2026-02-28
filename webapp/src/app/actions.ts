"use server";

import React from "react";
import { createClient } from "@supabase/supabase-js";
import { resend } from "@/lib/resend";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { WaitlistConfirmationEmail } from "@/emails/waitlist-confirmation";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function insertWaitlistEmail(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  const { error } = await supabase.from("waitlist").insert({
    email: normalizedEmail,
  });

  if (error) {
    console.error("Supabase insert error:", error);
    if (error.code === "23505") {
      return { success: false, error: "This email is already on the waitlist." };
    }
    return { success: false, error: "Something went wrong. Please try again." };
  }

  // Resend operations are best-effort — don't fail the signup
  try {
    await resend.contacts.create({
      email: normalizedEmail,
      unsubscribed: false,
    });
  } catch (e) {
    console.error("Resend contact creation error:", e);
  }

  try {
    const unsubscribeUrl = buildUnsubscribeUrl(normalizedEmail);

    await resend.emails.send({
      from: "Magister <waitlist@notifications.magistermarketing.com>",
      replyTo: "team@magistermarketing.com",
      to: normalizedEmail,
      subject: "You're on the waitlist",
      react: React.createElement(WaitlistConfirmationEmail, { unsubscribeUrl }),
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  } catch (e) {
    console.error("Resend email send error:", e);
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
