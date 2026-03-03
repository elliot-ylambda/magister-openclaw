import { NextRequest, NextResponse } from "next/server";
import React from "react";
import { createClient } from "@supabase/supabase-js";
import { resend } from "@/lib/resend";
import { buildUnsubscribeUrl } from "@/lib/unsubscribe";
import { UpdateBroadcastEmail } from "@/emails/update-broadcast";
import { BroadcastWaitlistUpdate1 } from "@/emails/broadcast-waitlist-update-1";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
  const { template, testEmail, subject, heading, previewText, contentHtml } =
    body as {
      template?: string;
      testEmail?: string;
      subject?: string;
      heading?: string;
      previewText?: string;
      contentHtml?: string;
    };

  // Resolve which email to send
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

  // Test mode: send to a single email without querying the waitlist
  if (testEmail) {
    try {
      const unsubscribeUrl = buildUnsubscribeUrl(testEmail);

      const reactElement = namedTemplate
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

      await resend.emails.send({
        from: "Magister <waitlist@notifications.magistermarketing.com>",
        replyTo: "team@magistermarketing.com",
        to: testEmail,
        subject: `[TEST] ${emailSubject}`,
        react: reactElement,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });

      return NextResponse.json({ sent: 1, test: true, to: testEmail });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Fetch all subscribed waitlist emails
  const { data: subscribers, error } = await supabase
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

  let sent = 0;
  const errors: { email: string; error: string }[] = [];

  for (const { email } of subscribers) {
    try {
      const unsubscribeUrl = buildUnsubscribeUrl(email);

      const reactElement = namedTemplate
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

      await resend.emails.send({
        from: "Magister <waitlist@notifications.magistermarketing.com>",
        replyTo: "team@magistermarketing.com",
        to: email,
        subject: emailSubject,
        react: reactElement,
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

  return NextResponse.json({
    sent,
    failed: errors.length,
    total: subscribers.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
