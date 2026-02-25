import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Magister Marketing - Autonomous AI Marketing Team";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function fetchFont(
  family: string,
  weight = 400
): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(
      `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } }
    ).then((r) => r.text());

    const url = css.match(/src: url\((.+?)\) format\('woff2'\)/)?.[1];
    if (!url) return null;
    return fetch(url).then((r) => r.arrayBuffer());
  } catch {
    return null;
  }
}

export default async function Image() {
  const [instrumentSerifFont, dmSansRegular, dmSansSemibold] =
    await Promise.all([
      fetchFont("Instrument+Serif", 400),
      fetchFont("DM+Sans", 400),
      fetchFont("DM+Sans", 600),
    ]);

  const fonts = [
    instrumentSerifFont && {
      name: "Instrument Serif",
      data: instrumentSerifFont,
      style: "normal" as const,
      weight: 400 as const,
    },
    dmSansRegular && {
      name: "DM Sans",
      data: dmSansRegular,
      style: "normal" as const,
      weight: 400 as const,
    },
    dmSansSemibold && {
      name: "DM Sans",
      data: dmSansSemibold,
      style: "normal" as const,
      weight: 600 as const,
    },
  ].filter(Boolean) as { name: string; data: ArrayBuffer; style: "normal"; weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 }[];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Subtle radial glow */}
        <div
          style={{
            position: "absolute",
            top: "-200px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "800px",
            height: "800px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            marginBottom: "32px",
          }}
        >
          <div
            style={{
              width: "36px",
              height: "40px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "28px",
              fontFamily: "Instrument Serif",
              color: "white",
              border: "2px solid rgba(255,255,255,0.2)",
              borderRadius: "6px",
            }}
          >
            M
          </div>
          <span
            style={{
              fontFamily: "DM Sans",
              fontSize: "18px",
              fontWeight: 600,
              letterSpacing: "0.12em",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            MAGISTER
          </span>
        </div>

        {/* Headline */}
        <div
          style={{
            fontFamily: "Instrument Serif",
            fontSize: "72px",
            fontWeight: 400,
            color: "white",
            lineHeight: 1.1,
            textAlign: "center",
            maxWidth: "900px",
            display: "flex",
          }}
        >
          Your autonomous AI marketing team
        </div>

        {/* Subheadline */}
        <div
          style={{
            fontFamily: "DM Sans",
            fontSize: "24px",
            fontWeight: 400,
            color: "rgba(255,255,255,0.5)",
            marginTop: "24px",
            textAlign: "center",
            maxWidth: "700px",
            display: "flex",
          }}
        >
          AI agents that ship real marketing work — not drafts.
        </div>

        {/* Bottom border accent */}
        <div
          style={{
            position: "absolute",
            bottom: "0",
            left: "0",
            right: "0",
            height: "4px",
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)",
            display: "flex",
          }}
        />
      </div>
    ),
    {
      ...size,
      fonts,
    }
  );
}
