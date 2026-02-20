import type { Metadata } from "next";
import { Geist, DM_Sans, Instrument_Serif } from "next/font/google";
import Fathom from "@/components/fathom";
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
        <Fathom />
        {children}
      </body>
    </html>
  );
}
