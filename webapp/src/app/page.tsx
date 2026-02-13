"use client";

import { useRef } from "react";
import Image from "next/image";
import {
  motion,
  useInView,
  useScroll,
  useTransform,
} from "motion/react";
import {
  PenTool,
  Search,
  Share2,
  Radar,
  Star,
  BarChart3,
  Shield,
  Cpu,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const agents = [
  {
    icon: PenTool,
    name: "Content Architect",
    description:
      "Crafts blog posts, landing pages, and email campaigns that convert.",
  },
  {
    icon: Search,
    name: "SEO Strategist",
    description:
      "Optimizes rankings with keyword research, audits, and content gaps.",
  },
  {
    icon: Share2,
    name: "Social Operator",
    description:
      "Manages posting schedules, engagement, and cross-platform presence.",
  },
  {
    icon: Radar,
    name: "Competitor Scout",
    description:
      "Tracks competitor moves, pricing changes, and market positioning.",
  },
  {
    icon: Star,
    name: "Review Commander",
    description: "Monitors and responds to reviews across every platform.",
  },
  {
    icon: BarChart3,
    name: "Analytics Decoder",
    description:
      "Turns raw data into actionable growth insights and reports.",
  },
];

const steps = [
  {
    number: "01",
    title: "Deploy",
    description:
      "Spin up your autonomous marketing team in minutes. One command, fully configured.",
  },
  {
    number: "02",
    title: "Configure",
    description:
      "Set your brand voice, target audience, and strategy. Each agent adapts to your context.",
  },
  {
    number: "03",
    title: "Monitor",
    description:
      "Watch your agents execute across every channel. Intervene only when you want to.",
  },
];

const credibilityItems = [
  {
    icon: Shield,
    headline: "Your data never leaves",
    description:
      "Runs entirely on your infrastructure. No third-party data sharing, ever.",
  },
  {
    icon: Cpu,
    headline: "Built for autonomy",
    description:
      "Agents collaborate, learn, and adapt without constant supervision.",
  },
  {
    icon: Users,
    headline: "Open source, transparent",
    description:
      "Fully auditable. Backed by a community that demands better marketing tools.",
  },
];

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

function FadeUp({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 32 }}
      transition={{ duration: 0.7, delay, ease: [0.25, 0.1, 0.25, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function Nav() {
  const { scrollY } = useScroll();
  const bgOpacity = useTransform(scrollY, [0, 100], [0, 0.85]);
  const borderOpacity = useTransform(scrollY, [0, 100], [0, 0.06]);

  return (
    <motion.nav
      className="fixed top-0 left-0 right-0 z-50 h-[72px] flex items-center"
      style={{
        backgroundColor: useTransform(bgOpacity, (v) => `rgba(0,0,0,${v})`),
        borderBottom: useTransform(
          borderOpacity,
          (v) => `1px solid rgba(255,255,255,${v})`
        ),
        backdropFilter: useTransform(scrollY, [0, 100], [
          "blur(0px)",
          "blur(12px)",
        ]),
        WebkitBackdropFilter: useTransform(scrollY, [0, 100], [
          "blur(0px)",
          "blur(12px)",
        ]),
      }}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 md:px-10">
        {/* Left — Logo + Name */}
        <a href="#" className="flex items-center gap-2.5">
          <Image
            src="/magister-logo-white.svg"
            alt="Magister"
            width={28}
            height={30}
          />
          <span
            className="text-[15px] font-medium text-white tracking-[0.12em] uppercase"
            style={{ fontFamily: "var(--font-dm-sans)" }}
          >
            Magister
          </span>
        </a>

        {/* Center — Links (desktop) */}
        <div
          className="hidden md:flex items-center gap-10"
          style={{ fontFamily: "var(--font-dm-sans)" }}
        >
          {["Agents", "How It Works", "Open Source"].map((label) => (
            <a
              key={label}
              href={`#${label.toLowerCase().replace(/\s+/g, "-")}`}
              className="text-[14px] transition-colors duration-300"
              style={{ color: "rgba(255,255,255,0.6)" }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.color = "rgba(255,255,255,1)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.color = "rgba(255,255,255,0.6)")
              }
            >
              {label}
            </a>
          ))}
        </div>

        {/* Right — CTA */}
        <a
          href="#request-access"
          className="rounded-full px-5 py-2 text-[13px] font-medium text-white transition-all duration-300 hover:bg-white hover:text-black"
          style={{
            fontFamily: "var(--font-dm-sans)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          Request Access
        </a>
      </div>
    </motion.nav>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section className="relative flex flex-col items-center px-6 pt-48 pb-32 md:pt-56 md:pb-48 text-center overflow-hidden">
      {/* Animated gradient orbs */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: "5%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(1000px, 100vw)",
          height: "700px",
          background: "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 40%, transparent 70%)",
          filter: "blur(40px)",
          animation: "heroGlow 10s ease-in-out infinite",
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          top: "15%",
          left: "35%",
          width: "600px",
          height: "400px",
          background: "radial-gradient(ellipse at center, rgba(120,119,198,0.08) 0%, transparent 60%)",
          filter: "blur(50px)",
          animation: "orbFloat1 14s ease-in-out infinite",
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          top: "10%",
          left: "60%",
          width: "500px",
          height: "450px",
          background: "radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 55%)",
          filter: "blur(50px)",
          animation: "orbFloat2 18s ease-in-out infinite",
        }}
      />

      {/* Dot grid pattern — fades from center */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "radial-gradient(ellipse 50% 45% at 50% 40%, black 10%, transparent 60%)",
          WebkitMaskImage: "radial-gradient(ellipse 50% 45% at 50% 40%, black 10%, transparent 60%)",
        }}
      />

      <style>{`
        @keyframes heroGlow {
          0%, 100% { transform: translateX(-50%) scale(1); opacity: 1; }
          50% { transform: translateX(-50%) scale(1.1); opacity: 0.6; }
        }
        @keyframes orbFloat1 {
          0%, 100% { transform: translate(0, 0); }
          33% { transform: translate(40px, -25px); }
          66% { transform: translate(-20px, 15px); }
        }
        @keyframes orbFloat2 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-35px, 20px); }
        }
      `}</style>

      {/* Stats strip */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.1 }}
        className="mb-10 flex items-center gap-3"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "rgba(255,255,255,0.4)",
          fontSize: "13px",
        }}
      >
        <span>Open Source</span>
        <span style={{ color: "rgba(255,255,255,0.2)" }}>·</span>
        <span>6 AI Agents</span>
        <span style={{ color: "rgba(255,255,255,0.2)" }}>·</span>
        <span>Local-First</span>
      </motion.div>

      {/* Headline */}
      <motion.h1
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        className="max-w-4xl text-white"
        style={{
          fontFamily: "var(--font-instrument-serif)",
          fontSize: "clamp(44px, 6vw, 80px)",
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          fontWeight: 400,
        }}
      >
        The first autonomous
        <br />
        marketing team
      </motion.h1>

      {/* Subtext */}
      <motion.p
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
        className="mt-7 max-w-xl text-lg leading-relaxed"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "rgba(255,255,255,0.6)",
          fontWeight: 400,
        }}
      >
        Six AI agents that handle content, SEO, social media, competitor
        intelligence, and reviews. Running locally, working autonomously.
      </motion.p>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.65, ease: [0.25, 0.1, 0.25, 1] }}
        className="mt-10"
      >
        <a
          href="#request-access"
          className="inline-block rounded-full bg-white px-8 py-3.5 text-[15px] font-medium text-black transition-opacity duration-300 hover:opacity-90"
          style={{ fontFamily: "var(--font-dm-sans)" }}
        >
          Request early access
        </a>
      </motion.div>

      {/* Divider */}
      <motion.div
        initial={{ opacity: 0, scaleX: 0 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 0.8, delay: 0.9 }}
        className="mt-32 h-px w-[200px]"
        style={{ backgroundColor: "rgba(255,255,255,0.06)" }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section Label (reusable)
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mb-5 text-center text-xs uppercase"
      style={{
        fontFamily: "var(--font-dm-sans)",
        color: "rgba(255,255,255,0.3)",
        letterSpacing: "0.15em",
        fontWeight: 400,
      }}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Agents Section
// ---------------------------------------------------------------------------

function AgentsSection() {
  return (
    <section id="agents" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <FadeUp className="text-center">
          <SectionLabel>The team</SectionLabel>
          <h2
            className="text-white"
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(32px, 4vw, 56px)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              fontWeight: 400,
            }}
          >
            Six agents, every function.
          </h2>
          <p
            className="mx-auto mt-6 max-w-lg text-base"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Each agent is a specialist. Together, they cover the full marketing
            surface.
          </p>
        </FadeUp>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent, i) => (
            <FadeUp key={agent.name} delay={0.08 * i}>
              <div
                className="rounded-lg p-10 transition-colors duration-300"
                style={{
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor =
                    "rgba(255,255,255,0.12)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor =
                    "rgba(255,255,255,0.06)")
                }
              >
                <agent.icon
                  size={20}
                  strokeWidth={1.5}
                  style={{ color: "rgba(255,255,255,0.6)" }}
                  className="mb-5"
                />
                <h3
                  className="mb-2.5 text-lg text-white"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  {agent.name}
                </h3>
                <p
                  className="text-sm leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                    fontWeight: 400,
                  }}
                >
                  {agent.description}
                </p>
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How It Works
// ---------------------------------------------------------------------------

function HowItWorksSection() {
  return (
    <section id="how-it-works" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <FadeUp className="text-center">
          <SectionLabel>The process</SectionLabel>
          <h2
            className="text-white"
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(32px, 4vw, 56px)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              fontWeight: 400,
            }}
          >
            Three steps.
          </h2>
        </FadeUp>

        <div className="mx-auto mt-20 grid max-w-5xl grid-cols-1 md:grid-cols-3">
          {steps.map((step, i) => (
            <FadeUp
              key={step.number}
              delay={0.12 * i}
              className={`py-10 md:py-0 md:px-10 ${
                i < steps.length - 1
                  ? "border-b border-[rgba(255,255,255,0.06)] md:border-b-0 md:border-r"
                  : ""
              }`}
            >
              <div>
                <p
                  className="mb-5 text-sm"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.2)",
                    fontWeight: 500,
                  }}
                >
                  {step.number}
                </p>
                <h3
                  className="mb-4 text-white"
                  style={{
                    fontFamily: "var(--font-instrument-serif)",
                    fontSize: "clamp(24px, 3vw, 32px)",
                    lineHeight: 1.2,
                    letterSpacing: "-0.02em",
                    fontWeight: 400,
                  }}
                >
                  {step.title}
                </h3>
                <p
                  className="text-base leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                    fontWeight: 400,
                  }}
                >
                  {step.description}
                </p>
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Credibility
// ---------------------------------------------------------------------------

function CredibilitySection() {
  return (
    <section id="open-source" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-3xl">
        <FadeUp className="text-center">
          <SectionLabel>Why Magister</SectionLabel>
        </FadeUp>

        <div className="mt-8 flex flex-col items-center">
          {credibilityItems.map((item, i) => (
            <FadeUp
              key={item.headline}
              delay={0.12 * i}
              className={`flex flex-col items-center text-center ${
                i < credibilityItems.length - 1 ? "mb-24" : ""
              }`}
            >
              <item.icon
                size={24}
                strokeWidth={1.5}
                className="mb-6"
                style={{ color: "rgba(255,255,255,0.4)" }}
              />
              <h3
                className="text-white"
                style={{
                  fontFamily: "var(--font-instrument-serif)",
                  fontSize: "clamp(24px, 3vw, 32px)",
                  lineHeight: 1.2,
                  letterSpacing: "-0.02em",
                  fontWeight: 400,
                  fontStyle: "italic",
                }}
              >
                {item.headline}
              </h3>
              <p
                className="mt-4 max-w-md text-base"
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  color: "rgba(255,255,255,0.5)",
                  fontWeight: 400,
                }}
              >
                {item.description}
              </p>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CTA Section
// ---------------------------------------------------------------------------

function CtaSection() {
  return (
    <section id="request-access" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-3xl text-center">
        <FadeUp>
          <h2
            className="text-white"
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(32px, 4vw, 56px)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              fontWeight: 400,
            }}
          >
            Ready to deploy?
          </h2>
          <p
            className="mx-auto mt-6 max-w-md text-base"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.6)",
              fontWeight: 400,
            }}
          >
            Join the teams replacing their marketing stack with six autonomous
            agents.
          </p>
          <div className="mt-10">
            <a
              href="#"
              className="inline-block rounded-full bg-white px-8 py-3.5 text-[15px] font-medium text-black transition-opacity duration-300 hover:opacity-90"
              style={{ fontFamily: "var(--font-dm-sans)" }}
            >
              Request early access
            </a>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer
      className="px-6 py-10"
      style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 sm:flex-row">
        <a href="#" className="flex items-center gap-2.5">
          <Image
            src="/magister-logo-white.svg"
            alt="Magister"
            width={22}
            height={24}
          />
          <span
            className="text-[14px] font-medium text-white"
            style={{ fontFamily: "var(--font-dm-sans)" }}
          >
            Magister
          </span>
        </a>
        <p
          className="text-[13px]"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "rgba(255,255,255,0.3)",
          }}
        >
          Built on OpenClaw
        </p>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  return (
    <main className="relative min-h-screen bg-black selection:bg-white/10">
      {/* Subtle grain texture across entire page */}
      <div
        className="pointer-events-none fixed inset-0 z-50"
        style={{
          opacity: 0.06,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }}
      />
      <Nav />
      <Hero />
      <AgentsSection />
      <HowItWorksSection />
      <CredibilitySection />
      <CtaSection />
      <Footer />
    </main>
  );
}
