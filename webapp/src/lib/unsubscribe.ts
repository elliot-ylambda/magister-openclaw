import { createHmac } from "crypto";

const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Generate an HMAC-signed unsubscribe token for a given email.
 * Format: base64url(email).signature
 */
export function generateUnsubscribeToken(email: string): string {
  const payload = Buffer.from(email).toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * Verify an unsubscribe token and return the email if valid.
 * Returns null if the token is invalid or tampered with.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expected = createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");

  if (signature !== expected) return null;

  try {
    return Buffer.from(payload, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Build the full unsubscribe URL for an email address.
 */
export function buildUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3020";
  return `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}
