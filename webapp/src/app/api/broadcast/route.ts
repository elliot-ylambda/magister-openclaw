import { NextRequest, NextResponse } from "next/server";
import React from "react";
import { createClient } from "@supabase/supabase-js";
import { resend } from "@/lib/resend";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { UpdateBroadcastEmail } from "@/emails/update-broadcast";
import { BroadcastWaitlistUpdate1 } from "@/emails/broadcast-waitlist-update-1";

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Named broadcast templates — add new ones here
const templates: Record<
  string,
  { subject: string; component: React.FC<{ unsubscribeUrl?: string }> }
> = {
  "waitlist-update-1": {
    subject: "Magister waitlist update: it's alive",
    component: BroadcastWaitlistUpdate1,
  },
};

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { template, to, testEmails, subject, heading, previewText, contentHtml } =
    body as {
      template?: string;
      to?: string | string[];
      testEmails?: string | string[];
      subject?: string;
      heading?: string;
      previewText?: string;
      contentHtml?: string;
    };

  // Resolve template
  const namedTemplate = template ? templates[template] : undefined;

  if (template && !namedTemplate) {
    return NextResponse.json(
      { error: `Unknown template: ${template}`, available: Object.keys(templates) },
      { status: 400 }
    );
  }

  const emailSubject = subject || namedTemplate?.subject;
  if (!emailSubject) {
    return NextResponse.json(
      { error: "subject is required (or use a named template)" },
      { status: 400 }
    );
  }

  function buildReactElement(unsubscribeUrl: string) {
    return namedTemplate
      ? React.createElement(namedTemplate.component, { unsubscribeUrl })
      : React.createElement(UpdateBroadcastEmail, {
          heading,
          previewText,
          content: contentHtml
            ? React.createElement("div", {
                dangerouslySetInnerHTML: { __html: contentHtml },
              })
            : undefined,
          unsubscribeUrl,
        });
  }

  async function sendToRecipients(
    recipients: string[],
    subjectLine: string
  ) {
    let sent = 0;
    const errors: { email: string; error: string }[] = [];

    for (const email of recipients) {
      try {
        const unsubscribeUrl = buildUnsubscribeUrl(email);

        await resend.emails.send({
          from: "Magister <waitlist@notifications.magistermarketing.com>",
          replyTo: "team@magistermarketing.com",
          to: email,
          subject: subjectLine,
          react: buildReactElement(unsubscribeUrl),
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });

        sent++;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        console.error(`Failed to send to ${email}:`, message);
        errors.push({ email, error: message });
      }
    }

    return { sent, errors };
  }

  // Test mode: send with [TEST] prefix
  if (testEmails) {
    const recipients = Array.isArray(testEmails) ? testEmails : [testEmails];
    const { sent, errors } = await sendToRecipients(
      recipients,
      `[TEST] ${emailSubject}`
    );

    return NextResponse.json({
      sent,
      failed: errors.length,
      test: true,
      to: recipients,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  // Direct send: specific addresses, real subject
  if (to) {
    const recipients = Array.isArray(to) ? to : [to];
    const { sent, errors } = await sendToRecipients(recipients, emailSubject);

    return NextResponse.json({
      sent,
      failed: errors.length,
      total: recipients.length,
      to: recipients,
      errors: errors.length > 0 ? errors : undefined,
    });
  }

  // Waitlist broadcast: all subscribed emails
  const { data: subscribers, error } = await getSupabase()
    .from("waitlist")
    .select("email")
    .eq("unsubscribed", false);

  if (error) {
    console.error("Failed to fetch subscribers:", error);
    return NextResponse.json(
      { error: "Failed to fetch subscribers" },
      { status: 500 }
    );
  }

  if (!subscribers || subscribers.length === 0) {
    return NextResponse.json({ sent: 0, message: "No subscribers found" });
  }

  const { sent, errors } = await sendToRecipients(
    subscribers.map((s) => s.email),
    emailSubject
  );

  return NextResponse.json({
    sent,
    failed: errors.length,
    total: subscribers.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
