"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glow } from "@/components/glow";

const constellationDots = [
  { x: 15, y: 20, size: 2, opacity: 0.2, delay: 0 },
  { x: 45, y: 35, size: 3, opacity: 0.35, delay: 0.5 },
  { x: 80, y: 15, size: 2, opacity: 0.25, delay: 1.2 },
  { x: 120, y: 50, size: 4, opacity: 0.3, delay: 0.8 },
  { x: 160, y: 25, size: 2, opacity: 0.4, delay: 1.5 },
  { x: 200, y: 60, size: 3, opacity: 0.2, delay: 0.3 },
  { x: 240, y: 30, size: 2, opacity: 0.35, delay: 2 },
  { x: 280, y: 55, size: 3, opacity: 0.25, delay: 1.8 },
  { x: 310, y: 10, size: 2, opacity: 0.3, delay: 0.6 },
  { x: 340, y: 45, size: 4, opacity: 0.2, delay: 1 },
  { x: 370, y: 70, size: 2, opacity: 0.4, delay: 2.2 },
  { x: 55, y: 65, size: 3, opacity: 0.3, delay: 1.4 },
  { x: 130, y: 80, size: 2, opacity: 0.2, delay: 0.9 },
  { x: 260, y: 85, size: 3, opacity: 0.35, delay: 1.7 },
  { x: 350, y: 40, size: 2, opacity: 0.25, delay: 2.5 },
];

const constellationLines = [
  { x1: 15, y1: 20, x2: 45, y2: 35 },
  { x1: 45, y1: 35, x2: 80, y2: 15 },
  { x1: 120, y1: 50, x2: 160, y2: 25 },
  { x1: 200, y1: 60, x2: 240, y2: 30 },
  { x1: 280, y1: 55, x2: 310, y2: 10 },
  { x1: 340, y1: 45, x2: 370, y2: 70 },
  { x1: 55, y1: 65, x2: 130, y2: 80 },
  { x1: 260, y1: 85, x2: 350, y2: 40 },
];

export function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 overflow-hidden">
      {/* Animated glow behind headline */}
      <Glow
        className="w-[600px] h-[600px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{
          animation: "pulse-glow 8s ease-in-out infinite",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Badge */}
        <Badge
          variant="outline"
          className="border-amber-accent/30 text-amber-accent bg-amber-accent/10"
        >
          Built on OpenClaw
        </Badge>

        {/* Headline */}
        <h1 className="font-[family-name:var(--font-space-grotesk)] text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-white max-w-4xl leading-[1.1]">
          Your marketing team just became autonomous.
        </h1>

        {/* Subtitle */}
        <p className="text-lg text-gray-400 max-w-2xl leading-relaxed">
          Magister Marketing deploys AI agents that handle content, SEO, social media,
          competitor intel, and reviews — running locally, working autonomously,
          reporting back to you.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3 mt-2">
          <Button
            className="bg-amber-accent hover:bg-orange-accent text-black font-semibold px-6 h-11 cursor-pointer"
            onClick={() => {
              document
                .getElementById("waitlist")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            Get Early Access
          </Button>
          <Button
            variant="outline"
            className="border-white/20 text-white hover:bg-white/5 px-6 h-11 cursor-pointer"
            onClick={() => {
              document
                .getElementById("how-it-works")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            See How It Works
          </Button>
        </div>

        {/* Constellation dots */}
        <div className="relative w-[400px] h-[100px] mt-8">
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 400 100"
            fill="none"
          >
            {constellationLines.map((line, i) => (
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke="white"
                strokeOpacity="0.1"
                strokeWidth="1"
              />
            ))}
          </svg>
          {constellationDots.map((dot, i) => (
            <div
              key={i}
              className="absolute rounded-full bg-white"
              style={{
                left: dot.x,
                top: dot.y,
                width: dot.size,
                height: dot.size,
                opacity: dot.opacity,
                animation: `twinkle ${3 + dot.delay}s ease-in-out ${dot.delay}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
