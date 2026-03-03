import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { resend } from "@/lib/resend";

async function unsubscribe(token: string): Promise<string | null> {
  const email = verifyUnsubscribeToken(token);
  if (!email) return null;

  const supabase = createServiceClient();

  // Update Supabase (primary source of truth)
  await supabase
    .from("waitlist")
    .update({ unsubscribed: true })
    .eq("email", email);

  // Update Resend contact (best-effort)
  try {
    const { data: contact } = await resend.contacts.get({ email });
    if (contact?.id) {
      await resend.contacts.update({ id: contact.id, unsubscribed: true });
    }
  } catch (e) {
    console.error("Resend unsubscribe error:", e);
  }

  return email;
}

/** GET — user clicks unsubscribe link in email */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return new NextResponse("Missing token", { status: 400 });
  }

  const email = await unsubscribe(token);
  if (!email) {
    return new NextResponse("Invalid or expired link", { status: 400 });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unsubscribed — Magister</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000;
      color: rgba(255,255,255,0.8);
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      text-align: center;
      max-width: 420px;
    }
    h1 {
      font-size: 28px;
      font-weight: 500;
      color: #fff;
      margin-bottom: 12px;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: rgba(255,255,255,0.5);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>You've been unsubscribed</h1>
    <p>You won't receive any more emails from Magister. If this was a mistake, just sign up again at <a href="https://magistermarketing.com" style="color:rgba(255,255,255,0.7)">magistermarketing.com</a>.</p>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** POST — one-click unsubscribe (RFC 8058) from email client */
export async function POST(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const email = await unsubscribe(token);
  if (!email) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  return new NextResponse(null, { status: 200 });
}
