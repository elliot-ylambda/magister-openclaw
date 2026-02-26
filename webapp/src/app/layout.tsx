import type { Metadata } from "next";
import { Geist, DM_Sans, Instrument_Serif } from "next/font/google";
import { SupabaseProvider } from "@/components/shared/supabase-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Magister Marketing - Autonomous AI Marketing Team",
  description:
    "Deploy AI agents that handle content, SEO, social media, competitor intel, and reviews. Built on OpenClaw.",
  metadataBase: new URL("https://magistermarketing.com"),
  openGraph: {
    title: "Magister Marketing - Autonomous AI Marketing Team",
    description:
      "AI agents that ship real marketing work — not drafts. Content, SEO, social, ads, and more.",
    url: "https://magistermarketing.com",
    siteName: "Magister Marketing",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Magister Marketing - Autonomous AI Marketing Team",
    description:
      "AI agents that ship real marketing work — not drafts. Content, SEO, social, ads, and more.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${dmSans.variable} ${instrumentSerif.variable} antialiased`}
      >
        <SupabaseProvider>{children}</SupabaseProvider>
      </body>
    </html>
  );
}
