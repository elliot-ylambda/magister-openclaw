"use client";

import { useState, useRef, useEffect, useCallback, FormEvent } from "react";
import Image from "next/image";
import {
  motion,
  useInView,
  useScroll,
  useTransform,
  AnimatePresence,
} from "motion/react";
import { insertWaitlistEmail, updateWaitlistSurvey } from "./actions";
import {
  PenTool,
  Search,
  TrendingUp,
  Megaphone,
  Zap,
  Lightbulb,
  X,
  ChevronRight,
  ChevronLeft,
  Check,
  Minus,
  ChevronDown,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const skills = [
  {
    icon: PenTool,
    name: "Copywriting & Content",
    description:
      "Landing pages, homepage, feature pages, email copy, social posts.",
  },
  {
    icon: Search,
    name: "SEO & Discovery",
    description:
      "Audits, programmatic pages, competitor alternatives, schema markup.",
  },
  {
    icon: TrendingUp,
    name: "Conversion Optimization",
    description:
      "Page CRO, signup flows, onboarding, forms, popups, paywalls.",
  },
  {
    icon: Megaphone,
    name: "Paid & Distribution",
    description:
      "Google Ads, Meta, LinkedIn campaign creation and management.",
  },
  {
    icon: Zap,
    name: "Growth Engineering",
    description:
      "Free tools, referral programs, A/B tests, analytics setup.",
  },
  {
    icon: Lightbulb,
    name: "Strategy & Planning",
    description:
      "Pricing, launch plans, marketing psychology, competitive intel.",
  },
];

const steps = [
  {
    number: "01",
    title: "Talk to it",
    description:
      "Open Magister on the web or in Slack. Describe what you need in plain English.",
  },
  {
    number: "02",
    title: "It plans and executes",
    description:
      "Magister taps into 25 specialized marketing skills to do the actual work — writing copy, auditing your SEO, building email sequences, optimizing pages.",
  },
  {
    number: "03",
    title: "You review and ship",
    description:
      "Check what it built, tweak if you want, and push it live. You stay in control.",
  },
];

const jobRoleOptions = ["Developer", "Marketer", "Founder", "Designer"];
const experienceOptions = ["Beginner", "Intermediate", "Advanced", "Expert"];
const aiProviderOptions = ["Claude Code", "Codex", "OpenClaw", "None"];
const channelOptions = ["Web App", "Slack", "Email", "WhatsApp", "Discord", "Text"];
const useCaseOptions = [
  "Landing pages & website copy",
  "SEO audits & improvements",
  "Email sequences & campaigns",
  "Paid ads management",
  "Social media content",
  "Conversion optimization",
  "Competitor analysis",
  "Content strategy",
  "Analytics & reporting",
  "Pricing & packaging",
  "Launch strategy",
  "Referral programs",
  "Programmatic SEO",
  "Free tool building",
];

const personas = [
  {
    title: "SaaS founders",
    subtitle: "wearing the marketing hat",
    description:
      "You've got 30 minutes between product calls. Magister turns that into a fully written landing page or email sequence.",
  },
  {
    title: "Solo marketers",
    subtitle: "doing the job of five",
    description:
      "You know what needs to happen. You just can't get to all of it. Magister handles the execution so you can focus on strategy.",
  },
  {
    title: "Growth teams",
    subtitle: "that move fast",
    description:
      "Your backlog of marketing tasks keeps growing. Magister works through it while you focus on what only humans can do.",
  },
];

const comparisonRows = [
  { label: "Gives you advice", chatbot: true, magister: true },
  { label: "Actually does the work", chatbot: false, magister: true },
  { label: "Works in your tools", chatbot: false, magister: true },
  { label: "Available 24/7", chatbot: true, magister: true },
  { label: "Knows your brand context", chatbot: "Per session", magister: true },
];

const faqItems = [
  {
    question: "Do I need to bring my own API keys?",
    answer:
      "You can bring your own API keys or use ours. Using ours means simpler billing and access to a versatile selection of LLM models without managing multiple provider accounts.",
  },
  {
    question: "How is this different from just using ChatGPT or Claude?",
    answer:
      "Chatbots give you text in a window. Magister is an autonomous agent that works in your actual tools — writing real pages, updating real files, running real audits.",
  },
  {
    question: "What can it actually do right now?",
    answer:
      "We're starting with one agent that covers 25 marketing skills — copywriting, SEO, CRO, email, ads, and more. We're expanding to a full team of specialized agents.",
  },
  {
    question: "Is my data safe?",
    answer:
      "Magister is built on Claude Code and OpenClaw. Your data is processed through Anthropic's API with their privacy guarantees.",
  },
  {
    question: "Can I use it in Slack?",
    answer:
      "Yes. You can interact with Magister on the web or directly in your Slack workspace.",
  },
];

type ChatMessage = {
  type: "user" | "bot";
  content: string;
};

type DemoTab = {
  label: string;
  script: ChatMessage[];
};

const demoTabs: DemoTab[] = [
  {
    label: "CRO",
    script: [
      {
        type: "user",
        content: "Our pricing page converts at 2%. Can you take a look?",
      },
      {
        type: "bot",
        content:
          "Auditing your pricing page now. Checking copy, layout, and conversion patterns...",
      },
      {
        type: "bot",
        content:
          "Found 3 issues:\n\n1. Headline focuses on features, not outcomes\n2. Too many plan options — decision fatigue\n3. No social proof near the CTA\n\nRewriting now.",
      },
      {
        type: "bot",
        content:
          'Done. Updated copy is in your staging environment:\n\n• New headline: "Start closing more deals today"\n• Consolidated 4 plans to 3 with a recommended badge\n• Added customer quote above the CTA\n\nReady to review?',
      },
    ],
  },
  {
    label: "Paid Ads",
    script: [
      {
        type: "user",
        content:
          "We're spending $3k/mo on Google Ads but barely getting leads. Can you help?",
      },
      {
        type: "bot",
        content:
          "Pulling your Google Ads account now. Analyzing campaigns, keywords, and landing pages...",
      },
      {
        type: "bot",
        content:
          "Found the problem:\n\n1. 60% of spend is on broad match keywords with <1% CTR\n2. Ad copy doesn't match landing page headline\n3. No negative keywords filtering out junk clicks\n\nRestructuring your campaigns now.",
      },
      {
        type: "bot",
        content:
          "Done. Here's what I changed:\n\n• Paused 12 low-performing keywords, added 34 negative keywords\n• Rewrote 3 ad variants with landing page-matched headlines\n• Set up conversion tracking that was missing\n\nProjected: 2-3x more leads at the same budget.",
      },
    ],
  },
  {
    label: "Content",
    script: [
      {
        type: "user",
        content:
          "We need a content strategy for our blog. Right now we just publish randomly.",
      },
      {
        type: "bot",
        content:
          "Analyzing your site, competitors, and keyword opportunities...",
      },
      {
        type: "bot",
        content:
          "Here's what I found:\n\n1. Your top 3 competitors rank for 2,400 keywords you don't\n2. You have 8 existing posts that could rank on page 1 with updates\n3. Three topic clusters align perfectly with your product.\n\nBuilding your content calendar now.",
      },
      {
        type: "bot",
        content:
          "Done. Created a 90-day content plan:\n\n• 8 existing posts updated with better keywords and internal links\n• 12 new articles targeting high-intent keywords\n• 3 pillar pages to anchor each topic cluster\n\nFirst article draft is ready for review.",
      },
    ],
  },
  {
    label: "Email",
    script: [
      {
        type: "user",
        content:
          "Our trial-to-paid conversion is 4%. Can you build an email sequence to improve it?",
      },
      {
        type: "bot",
        content:
          "Reviewing your current onboarding flow and user activation data...",
      },
      {
        type: "bot",
        content:
          "Spotted 3 gaps:\n\n1. No email until day 3 — most drop-off happens in 24 hours\n2. Emails talk about features, not the outcomes users want\n3. No re-engagement for users who stall after signup.\n\nWriting a new 7-email sequence now.",
      },
      {
        type: "bot",
        content:
          "Done. Here's the new sequence:\n\n• Day 0: Welcome + quick-win tutorial (get value in 5 min)\n• Day 1: Case study showing their use case\n• Day 3: \"Did you try X?\" based on their activity\n• Day 5, 7, 10, 14: Progressive nudges with social proof\n\nAll emails are drafted and ready to load into your ESP.",
      },
    ],
  },
  {
    label: "SEO",
    script: [
      {
        type: "user",
        content:
          "We're on page 3 for our main keyword. What's going on?",
      },
      {
        type: "bot",
        content:
          "Running a full SEO audit — checking technical issues, content gaps, and backlink profile...",
      },
      {
        type: "bot",
        content:
          "Found 4 issues holding you back:\n\n1. Page speed is 2.8s — needs to be under 1.5s\n2. Title tag and H1 don't include the target keyword\n3. Thin content — your page is 400 words, top 3 results average 2,200\n4. Zero internal links pointing to this page.",
      },
      {
        type: "bot",
        content:
          "Done. Here's what I fixed:\n\n• Optimized images and deferred scripts — load time now 1.2s\n• Rewrote title, meta description, and H1 with target keyword\n• Expanded content to 2,100 words with FAQ schema\n• Added 6 internal links from your highest-authority pages\n\nShould start climbing within 2-3 weeks.",
      },
    ],
  },
  {
    label: "Social",
    script: [
      {
        type: "user",
        content:
          "We post on LinkedIn 3x/week but get almost no engagement. Help?",
      },
      {
        type: "bot",
        content:
          "Analyzing your last 30 posts — looking at format, timing, hooks, and audience signals...",
      },
      {
        type: "bot",
        content:
          "Here's what's off:\n\n1. Posts are company announcements — LinkedIn rewards personal stories and insights\n2. No hook in the first line — 80% of people scroll past\n3. Posting at 4pm — your audience is most active at 8-9am.\n\nRewriting your next week of posts now.",
      },
      {
        type: "bot",
        content:
          "Done. 5 posts ready to go:\n\n• Mon: Founder story with a contrarian take on your industry\n• Tue: Carousel breaking down a customer win\n• Wed: Short poll about a pain point your product solves\n• Thu: Behind-the-scenes on a recent product decision\n• Fri: Quick tip thread with a clear CTA\n\nAll scheduled for 8:30am in your timezone.",
      },
    ],
  },
];

const integrations = [
  { name: "Google Analytics", logo: "/integrations/googleanalytics.svg" },
  { name: "Google Ads", logo: "/integrations/googleads.svg" },
  { name: "Meta Ads", logo: "/integrations/meta.svg" },
  { name: "HubSpot", logo: "/integrations/hubspot.svg" },
  { name: "Kit", logo: "/integrations/kit.svg" },
  { name: "Stripe", logo: "/integrations/stripe.svg" },
  { name: "Ahrefs", logo: "/integrations/ahrefs.svg" },
  { name: "Zapier", logo: "/integrations/zapier.svg" },
  { name: "PostHog", logo: "/integrations/posthog.svg" },
  { name: "Webflow", logo: "/integrations/webflow.svg" },
  { name: "Buffer", logo: "/integrations/buffer.svg" },
  { name: "Intercom", logo: "/integrations/intercom.svg" },
  { name: "Notion", logo: "/integrations/notion.svg" },
  { name: "Search Console", logo: "/integrations/googlesearchconsole.svg" },
  { name: "Hotjar", logo: "/integrations/hotjar.svg" },
  { name: "Mixpanel", logo: "/integrations/mixpanel.svg" },
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
// Email Form (reused in Hero and CTA)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailForm({
  onSubmit,
  id,
}: {
  onSubmit: (email: string) => Promise<{ success: boolean; error?: string }>;
  id: string;
}) {
  const [email, setEmail] = useState("");
  const [shaking, setShaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const triggerShake = () => {
    setShaking(true);
    setTimeout(() => setShaking(false), 500);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_REGEX.test(trimmed)) {
      triggerShake();
      setErrorMessage("Please enter a valid email address.");
      setEmail("");
      setTimeout(() => setErrorMessage(null), 3000);
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    const result = await onSubmit(trimmed);
    setIsLoading(false);
    if (!result.success) {
      triggerShake();
      setErrorMessage(result.error ?? "Something went wrong.");
      setTimeout(() => setErrorMessage(null), 4000);
    }
  };

  return (
    <div className="w-full max-w-xl">
      <form onSubmit={handleSubmit} noValidate className="flex w-full flex-col sm:flex-row gap-3">
        <input
          id={id}
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (errorMessage) setErrorMessage(null);
          }}
          disabled={isLoading}
          placeholder="you@company.com"
          className="flex-1 rounded-full border px-6 py-4 text-[16px] text-white placeholder:text-white/30 bg-transparent outline-none focus:border-white/40 transition-colors disabled:opacity-50"
          style={{
            fontFamily: "var(--font-dm-sans)",
            borderColor: "rgba(255,255,255,0.15)",
          }}
        />
        <motion.button
          type="submit"
          disabled={isLoading}
          className="relative overflow-hidden rounded-full bg-white px-8 py-4 text-[16px] font-medium text-black whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ fontFamily: "var(--font-dm-sans)" }}
          animate={
            shaking
              ? { x: [0, -8, 8, -6, 6, -3, 3, 0] }
              : {}
          }
          transition={{ duration: 0.5 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.97 }}
        >
          <span className="relative z-10">
            {isLoading ? "Joining..." : "Get early access"}
          </span>
          <motion.span
            className="absolute inset-0 rounded-full"
            style={{
              background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0) 100%)",
            }}
            initial={{ translateX: "-100%" }}
            animate={{ translateX: "100%" }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", repeatDelay: 2 }}
          />
        </motion.button>
      </form>
      <AnimatePresence>
        {errorMessage && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mt-2.5 text-center text-[13px]"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,100,100,0.8)",
            }}
          >
            {errorMessage}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Survey Popup
// ---------------------------------------------------------------------------

function SurveyPopup({
  email,
  onClose,
}: {
  email: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({
    roles: [] as string[],
    experience: [] as string[],
    aiProviders: [] as string[],
    channels: [] as string[],
    useCases: [] as string[],
  });
  const [otherAiProvider, setOtherAiProvider] = useState("");
  const [otherChannel, setOtherChannel] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const showExperience = !answers.aiProviders.includes("None");
  const totalSteps = showExperience ? 5 : 4;

  const handleToggle = (field: keyof typeof answers, value: string) => {
    setAnswers((prev) => {
      const current = prev[field];
      if (field === "aiProviders") {
        if (value === "None") {
          setOtherAiProvider("");
          return { ...prev, [field]: current.includes("None") ? [] : ["None"] };
        }
        if (value === "Other") {
          if (current.includes("Other")) {
            setOtherAiProvider("");
            return { ...prev, [field]: current.filter((v) => v !== "Other") };
          }
          return { ...prev, [field]: [...current.filter((v) => v !== "None"), "Other"] };
        }
        const without = current.filter((v) => v !== "None");
        return {
          ...prev,
          [field]: without.includes(value)
            ? without.filter((v) => v !== value)
            : [...without, value],
        };
      }
      if (field === "channels") {
        if (value === "Other") {
          if (current.includes("Other")) {
            setOtherChannel("");
            return { ...prev, [field]: current.filter((v) => v !== "Other") };
          }
          return { ...prev, [field]: [...current, "Other"] };
        }
        return {
          ...prev,
          [field]: current.includes(value)
            ? current.filter((v) => v !== value)
            : [...current, value],
        };
      }
      return {
        ...prev,
        [field]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      };
    });
  };

  // Map step index to logical field, accounting for conditional experience step
  // showExperience=true:  0=roles, 1=aiProviders, 2=experience, 3=channels, 4=useCases
  // showExperience=false: 0=roles, 1=aiProviders, 2=channels, 3=useCases
  const getStepField = (s: number): string => {
    if (s === 0) return "roles";
    if (s === 1) return "aiProviders";
    if (showExperience && s === 2) return "experience";
    const offset = showExperience ? 3 : 2;
    if (s === offset) return "channels";
    if (s === offset + 1) return "useCases";
    return "";
  };

  const canProceed = () => {
    const field = getStepField(step);
    switch (field) {
      case "roles":
        return answers.roles.length > 0;
      case "aiProviders":
        if (answers.aiProviders.length === 0) return false;
        if (answers.aiProviders.includes("Other") && otherAiProvider.trim() === "") return false;
        return true;
      case "experience":
        return answers.experience.length > 0;
      case "channels":
        if (answers.channels.length === 0) return false;
        if (answers.channels.includes("Other") && otherChannel.trim() === "") return false;
        return true;
      case "useCases":
        return answers.useCases.length > 0;
      default:
        return false;
    }
  };

  const handleNext = async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    let result: { success: boolean; error?: string };
    const field = getStepField(step);

    if (field === "roles") {
      result = await updateWaitlistSurvey(email, { roles: answers.roles });
    } else if (field === "aiProviders") {
      const resolvedProviders = answers.aiProviders.map((v) =>
        v === "Other" ? otherAiProvider.trim() : v
      ).filter(Boolean);
      result = await updateWaitlistSurvey(email, { ai_providers: resolvedProviders });
    } else if (field === "experience") {
      result = await updateWaitlistSurvey(email, { experience: answers.experience });
    } else if (field === "channels") {
      const resolvedChannels = answers.channels.map((v) =>
        v === "Other" ? otherChannel.trim() : v
      ).filter(Boolean);
      result = await updateWaitlistSurvey(email, { channels: resolvedChannels });
    } else {
      result = await updateWaitlistSurvey(email, { use_cases: answers.useCases });
    }

    setIsSubmitting(false);

    if (!result.success) {
      setSubmitError(result.error ?? "Something went wrong.");
      return;
    }

    if (step < totalSteps - 1) {
      setStep(step + 1);
    } else {
      setSubmitted(true);
    }
  };

  const optionButtonStyle = (selected: boolean, disabled = false) => ({
    fontFamily: "var(--font-dm-sans)",
    border: `1px solid ${selected ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.08)"}`,
    color: disabled
      ? "rgba(255,255,255,0.2)"
      : selected
        ? "white"
        : "rgba(255,255,255,0.6)",
    backgroundColor: selected ? "rgba(255,255,255,0.05)" : "transparent",
    cursor: disabled ? ("not-allowed" as const) : ("pointer" as const),
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{
        backgroundColor: "rgba(0,0,0,0.8)",
        backdropFilter: "blur(8px)",
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3 }}
        className="relative w-full max-w-lg rounded-2xl p-8"
        style={{
          backgroundColor: "rgb(12,12,12)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-1 transition-colors"
          style={{ color: "rgba(255,255,255,0.3)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.color = "rgba(255,255,255,0.7)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = "rgba(255,255,255,0.3)")
          }
        >
          <X size={18} />
        </button>

        {submitted ? (
          <div className="text-center py-8">
            <h3
              className="text-xl text-white mb-3"
              style={{
                fontFamily: "var(--font-dm-sans)",
                fontWeight: 600,
              }}
            >
              You&apos;re on the list
            </h3>
            <p
              className="text-base"
              style={{
                fontFamily: "var(--font-dm-sans)",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              We&apos;ll be in touch soon. Thanks for the info — it helps us
              build the right thing.
            </p>
            <button
              onClick={onClose}
              className="mt-6 rounded-full bg-white px-6 py-3 text-[15px] font-medium text-black transition-opacity hover:opacity-90"
              style={{ fontFamily: "var(--font-dm-sans)" }}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Progress bar */}
            <div className="mt-4 mb-8 flex gap-1.5">
              {Array.from({ length: totalSteps }).map((_, i) => (
                <div
                  key={i}
                  className="h-1 flex-1 rounded-full transition-colors duration-300"
                  style={{
                    backgroundColor:
                      i <= step
                        ? "rgba(255,255,255,0.6)"
                        : "rgba(255,255,255,0.08)",
                  }}
                />
              ))}
            </div>

            {/* Step 0: Role */}
            {step === 0 && (
              <div>
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  What best describes you?
                </h3>
                <p
                  className="text-sm mb-6"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  Select all that apply.
                </p>
                <div className="flex flex-col gap-2">
                  {jobRoleOptions.map((option) => {
                    const selected = answers.roles.includes(option);
                    return (
                      <button
                        key={option}
                        onClick={() => handleToggle("roles", option)}
                        className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[14px] transition-colors"
                        style={optionButtonStyle(selected)}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                          style={{
                            border: `1px solid ${selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                            backgroundColor: selected ? "rgba(255,255,255,0.1)" : "transparent",
                          }}
                        >
                          {selected && <Check size={14} strokeWidth={2} />}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 1: AI providers */}
            {step === 1 && (
              <div>
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  AI Agents you currently use
                </h3>
                <p
                  className="text-sm mb-6"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  Select all that apply.
                </p>
                <div className="flex flex-col gap-2">
                  {[...aiProviderOptions, "Other"].map((option) => {
                    const selected = answers.aiProviders.includes(option);
                    return (
                      <div key={option}>
                        <button
                          onClick={() => handleToggle("aiProviders", option)}
                          className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[14px] transition-colors"
                          style={optionButtonStyle(selected)}
                        >
                          <span
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                            style={{
                              border: `1px solid ${selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                              backgroundColor: selected ? "rgba(255,255,255,0.1)" : "transparent",
                            }}
                          >
                            {selected && <Check size={14} strokeWidth={2} />}
                          </span>
                          {option}
                        </button>
                        {option === "Other" && selected && (
                          <input
                            type="text"
                            value={otherAiProvider}
                            onChange={(e) => setOtherAiProvider(e.target.value)}
                            placeholder="Which AI agent?"
                            autoFocus
                            className="mt-2 w-full rounded-lg border px-4 py-2.5 text-[14px] text-white placeholder:text-white/30 bg-transparent outline-none focus:border-white/30 transition-colors"
                            style={{
                              fontFamily: "var(--font-dm-sans)",
                              borderColor: "rgba(255,255,255,0.12)",
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step 2: Experience (only if they use AI agents) */}
            {getStepField(step) === "experience" && (
              <div>
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  Level of experience with{" "}
                  {answers.aiProviders
                    .filter((v) => v !== "None")
                    .map((v) => (v === "Other" ? otherAiProvider.trim() : v))
                    .filter(Boolean)
                    .join(", ")}
                </h3>
                <p
                  className="text-sm mb-6"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  Select all that apply.
                </p>
                <div className="flex flex-col gap-2">
                  {experienceOptions.map((option) => {
                    const selected = answers.experience.includes(option);
                    return (
                      <button
                        key={option}
                        onClick={() => handleToggle("experience", option)}
                        className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[14px] transition-colors"
                        style={optionButtonStyle(selected)}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                          style={{
                            border: `1px solid ${selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                            backgroundColor: selected ? "rgba(255,255,255,0.1)" : "transparent",
                          }}
                        >
                          {selected && <Check size={14} strokeWidth={2} />}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Channels step */}
            {getStepField(step) === "channels" && (
              <div>
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  How do you want to talk to your agent?
                </h3>
                <p
                  className="text-sm mb-6"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  Select all that apply.
                </p>
                <div className="flex flex-col gap-2">
                  {[...channelOptions, "Other"].map((option) => {
                    const selected = answers.channels.includes(option);
                    return (
                      <div key={option}>
                        <button
                          onClick={() => handleToggle("channels", option)}
                          className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[14px] transition-colors"
                          style={optionButtonStyle(selected)}
                        >
                          <span
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                            style={{
                              border: `1px solid ${selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                              backgroundColor: selected ? "rgba(255,255,255,0.1)" : "transparent",
                            }}
                          >
                            {selected && <Check size={14} strokeWidth={2} />}
                          </span>
                          {option}
                        </button>
                        {option === "Other" && selected && (
                          <input
                            type="text"
                            value={otherChannel}
                            onChange={(e) => setOtherChannel(e.target.value)}
                            placeholder="Which channel?"
                            autoFocus
                            className="mt-2 w-full rounded-lg border px-4 py-2.5 text-[14px] text-white placeholder:text-white/30 bg-transparent outline-none focus:border-white/30 transition-colors"
                            style={{
                              fontFamily: "var(--font-dm-sans)",
                              borderColor: "rgba(255,255,255,0.12)",
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Use cases step */}
            {getStepField(step) === "useCases" && (
              <div>
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  What would you use it for first?
                </h3>
                <p
                  className="text-sm mb-6"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                >
                  Pick your top 3.
                </p>
                <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
                  {useCaseOptions.map((option) => {
                    const selected = answers.useCases.includes(option);
                    const disabled = !selected && answers.useCases.length >= 3;
                    return (
                      <button
                        key={option}
                        onClick={() => {
                          if (disabled) return;
                          setAnswers((prev) => ({
                            ...prev,
                            useCases: selected
                              ? prev.useCases.filter((u) => u !== option)
                              : [...prev.useCases, option],
                          }));
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-[14px] transition-colors"
                        style={optionButtonStyle(selected, disabled)}
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                          style={{
                            border: `1px solid ${selected ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"}`,
                            backgroundColor: selected ? "rgba(255,255,255,0.1)" : "transparent",
                          }}
                        >
                          {selected && <Check size={14} strokeWidth={2} />}
                        </span>
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="mt-8 flex items-center justify-between">
              {step > 0 ? (
                <button
                  onClick={() => setStep(step - 1)}
                  className="flex items-center gap-1 text-[14px] transition-colors"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "rgba(255,255,255,0.7)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "rgba(255,255,255,0.4)")
                  }
                >
                  <ChevronLeft size={16} />
                  Back
                </button>
              ) : (
                <div />
              )}
              <button
                onClick={handleNext}
                disabled={!canProceed() || isSubmitting}
                className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[14px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ fontFamily: "var(--font-dm-sans)" }}
              >
                {isSubmitting ? "Saving..." : step === totalSteps - 1 ? "Finish" : "Next"}
                {!isSubmitting && <ChevronRight size={16} />}
              </button>
            </div>

            {submitError && (
              <p
                className="mt-3 text-center text-sm"
                style={{ fontFamily: "var(--font-dm-sans)", color: "rgba(239,68,68,0.9)" }}
              >
                {submitError}
              </p>
            )}
          </>
        )}
      </motion.div>
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

        <div
          className="hidden md:flex items-center gap-10"
          style={{ fontFamily: "var(--font-dm-sans)" }}
        >
          {["How It Works", "Skills", "About"].map((label) => (
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

        <a
          href="#request-access"
          className="rounded-full px-5 py-2 text-[13px] font-medium text-white transition-all duration-300 hover:bg-white hover:text-black"
          style={{
            fontFamily: "var(--font-dm-sans)",
            border: "1px solid rgba(255,255,255,0.2)",
          }}
        >
          Request Early Access
        </a>
      </div>
    </motion.nav>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero({
  onEmailSubmit,
}: {
  onEmailSubmit: (email: string) => Promise<{ success: boolean; error?: string }>;
}) {
  return (
    <section className="relative flex flex-col items-center px-6 pt-48 pb-16 md:pt-56 md:pb-32 text-center overflow-hidden">
      {/* Animated gradient orbs */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: "5%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(1000px, 100vw)",
          height: "700px",
          background:
            "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 40%, transparent 70%)",
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
          background:
            "radial-gradient(ellipse at center, rgba(120,119,198,0.08) 0%, transparent 60%)",
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
          background:
            "radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 55%)",
          filter: "blur(50px)",
          animation: "orbFloat2 18s ease-in-out infinite",
        }}
      />

      {/* Dot grid pattern */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(ellipse 50% 45% at 50% 40%, black 10%, transparent 60%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 50% 45% at 50% 40%, black 10%, transparent 60%)",
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
        <span>Open Source Foundation</span>
        <span style={{ color: "rgba(255,255,255,0.2)" }}>&middot;</span>
        <span>Powered by OpenClaw</span>
      </motion.div>

      {/* Headline */}
      <motion.h1
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.8,
          delay: 0.25,
          ease: [0.25, 0.1, 0.25, 1],
        }}
        className="max-w-4xl text-white"
        style={{
          fontFamily: "var(--font-instrument-serif)",
          fontSize: "clamp(44px, 6vw, 80px)",
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          fontWeight: 400,
        }}
      >
        Ship more marketing this week
        <br />
        than most teams do in a year
      </motion.h1>

      {/* Subtext */}
      <motion.p
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.7,
          delay: 0.45,
          ease: [0.25, 0.1, 0.25, 1],
        }}
        className="mt-7 max-w-xl text-lg leading-relaxed"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "rgba(255,255,255,0.6)",
          fontWeight: 400,
        }}
      >
        Other AI tools give you a draft and send you on your way. Magister
        is an autonomous marketing agent that works in your tools — auditing
        SEO, building email sequences, managing ads, building reports,
        scheduling social content. You give it a task. It gets it done.
      </motion.p>

      {/* Email CTA */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.6,
          delay: 0.65,
          ease: [0.25, 0.1, 0.25, 1],
        }}
        className="mt-10 w-full max-w-xl"
      >
        <EmailForm onSubmit={onEmailSubmit} id="hero-email" />
      </motion.div>

      {/* Divider */}
      <motion.div
        initial={{ opacity: 0, scaleX: 0 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 0.8, delay: 0.9 }}
        className="mt-16 h-px w-[200px] md:mt-24"
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
// Problem Section
// ---------------------------------------------------------------------------

function ProblemSection() {
  return (
    <section className="px-6 py-16 md:py-32">
      <div className="mx-auto max-w-2xl text-center">
        <FadeUp>
          <SectionLabel>Sound familiar?</SectionLabel>
          <p
            className="text-xl leading-relaxed md:text-2xl"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.7)",
              fontWeight: 400,
            }}
          >
            You ask AI for help with your marketing. It gives you a plan, a
            draft, maybe some suggestions. Then you close the chat and spend
            the next several weeks implementing it yourself.
          </p>
          <p
            className="mt-8 text-xl md:text-2xl text-white"
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            What if the AI could just... do it?
          </p>
        </FadeUp>
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
          <SectionLabel>How it works</SectionLabel>
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
            Tell it what you need. It gets to work.
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
// Skills Section
// ---------------------------------------------------------------------------

function SkillsSection() {
  return (
    <section id="skills" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <FadeUp className="text-center">
          <SectionLabel>25 marketing skills</SectionLabel>
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
            One agent. 25 specialized skills.
          </h2>
          <p
            className="mx-auto mt-6 max-w-lg text-base"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Built on Claude Code and OpenClaw. Enhanced by{" "}
            <a
              href="https://github.com/coreyhaines31/marketingskills"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 decoration-white/30 hover:decoration-white/60 transition-colors"
              style={{ color: "rgba(255,255,255,0.8)" }}
            >
              Marketing Skills
            </a>
            , an open source, crowdsourced knowledge base that gets smarter
            with every user.
          </p>
        </FadeUp>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill, i) => (
            <FadeUp key={skill.name} delay={0.08 * i}>
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
                <skill.icon
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
                  {skill.name}
                </h3>
                <p
                  className="text-sm leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                    fontWeight: 400,
                  }}
                >
                  {skill.description}
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
// Demo Section (animated chat)
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: "rgba(255,255,255,0.4)",
            animation: `typingDot 1.4s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes typingDot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

function DemoSection() {
  const [activeTab, setActiveTab] = useState(0);
  const [visibleMessages, setVisibleMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasStarted = useRef(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const inView = useInView(sectionRef, { once: true, margin: "-100px" });

  const runChat = useCallback((tabIndex: number) => {
    // Cancel any in-progress animation
    if (cancelRef.current) cancelRef.current();

    const script = demoTabs[tabIndex].script;
    setActiveTab(tabIndex);
    setVisibleMessages([]);
    setIsTyping(false);

    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };

    let currentIndex = 0;

    const showNext = () => {
      if (cancelled) return;

      if (currentIndex >= script.length) {
        // Done with this tab — wait, then advance to next
        setTimeout(() => {
          if (cancelled) return;
          const nextTab = (tabIndex + 1) % demoTabs.length;
          runChat(nextTab);
        }, 3000);
        return;
      }

      setIsTyping(true);

      const typingDelay = script[currentIndex].type === "bot" ? 1800 : 800;

      setTimeout(() => {
        if (cancelled) return;
        setIsTyping(false);
        const msg = script[currentIndex];
        if (msg) {
          setVisibleMessages((prev) => [...prev, msg]);
        }
        currentIndex++;
        setTimeout(showNext, 1200);
      }, typingDelay);
    };

    setTimeout(showNext, 800);
  }, []);

  const handleTabClick = useCallback(
    (tabIndex: number) => {
      runChat(tabIndex);
    },
    [runChat],
  );

  useEffect(() => {
    if (inView && !hasStarted.current) {
      hasStarted.current = true;
      runChat(0);
    }
  }, [inView, runChat]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleMessages, isTyping]);

  return (
    <section ref={sectionRef} className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-3xl">
        <FadeUp className="text-center">
          <SectionLabel>See it in action</SectionLabel>
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
            You talk. It markets.
          </h2>
        </FadeUp>

        <FadeUp delay={0.15}>
          <div
            className="mt-16 rounded-xl overflow-hidden"
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
              backgroundColor: "rgba(255,255,255,0.02)",
            }}
          >
            {/* Chat header */}
            <div
              className="flex items-center gap-3 px-5 py-4"
              style={{
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: "rgba(74,222,128,0.8)" }}
              />
              <span
                className="text-[13px]"
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  color: "rgba(255,255,255,0.5)",
                  fontWeight: 500,
                }}
              >
                Magister
              </span>
              <div className="ml-auto flex gap-1">
                {demoTabs.map((tab, i) => (
                  <button
                    key={tab.label}
                    onClick={() => handleTabClick(i)}
                    className="px-3 py-1 rounded-md text-[12px] transition-colors"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      fontWeight: 500,
                      color:
                        activeTab === i
                          ? "rgba(255,255,255,0.9)"
                          : "rgba(255,255,255,0.4)",
                      backgroundColor:
                        activeTab === i
                          ? "rgba(255,255,255,0.08)"
                          : "transparent",
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Chat messages */}
            <div
              ref={scrollRef}
              className="flex flex-col gap-4 p-5 overflow-y-auto"
              style={{ height: 420 }}
            >
              {visibleMessages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className={`flex ${msg.type === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className="max-w-[85%] rounded-xl px-4 py-3 text-[14px] leading-relaxed"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      backgroundColor:
                        msg.type === "user"
                          ? "rgba(255,255,255,0.1)"
                          : "rgba(255,255,255,0.04)",
                      color:
                        msg.type === "user"
                          ? "rgba(255,255,255,0.9)"
                          : "rgba(255,255,255,0.7)",
                      border:
                        msg.type === "user"
                          ? "1px solid rgba(255,255,255,0.12)"
                          : "1px solid rgba(255,255,255,0.06)",
                      whiteSpace: "pre-line",
                    }}
                  >
                    {msg.content}
                  </div>
                </motion.div>
              ))}

              {isTyping && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex justify-start"
                >
                  <div
                    className="rounded-xl"
                    style={{
                      backgroundColor: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <TypingIndicator />
                  </div>
                </motion.div>
              )}

            </div>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Integrations Section
// ---------------------------------------------------------------------------

function IntegrationsSection() {
  return (
    <section className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-5xl">
        <FadeUp className="text-center">
          <SectionLabel>Integrations</SectionLabel>
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
            Works with the tools you already use.
          </h2>
        </FadeUp>

        <FadeUp delay={0.15}>
          <div className="mt-16 grid grid-cols-2 sm:grid-cols-4 gap-4">
            {integrations.map((integration) => (
              <div
                key={integration.name}
                className="flex flex-col items-center justify-center gap-3 rounded-lg py-8 px-4 transition-colors duration-300"
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
                <Image
                  src={integration.logo}
                  alt={integration.name}
                  width={28}
                  height={28}
                  style={{ opacity: 0.6 }}
                />
                <span
                  className="text-[12px] text-center"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                    fontWeight: 500,
                  }}
                >
                  {integration.name}
                </span>
              </div>
            ))}
          </div>
        </FadeUp>

        <FadeUp delay={0.25}>
          <p
            className="mt-8 text-center text-[14px]"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.3)",
            }}
          >
            And more coming soon.
          </p>
        </FadeUp>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Personas Section
// ---------------------------------------------------------------------------

function PersonasSection() {
  return (
    <section className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <FadeUp className="text-center">
          <SectionLabel>Who it&apos;s for</SectionLabel>
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
            Built for marketers who&apos;d rather ship than plan.
          </h2>
        </FadeUp>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-3">
          {personas.map((persona, i) => (
            <FadeUp key={persona.title} delay={0.1 * i}>
              <div
                className="rounded-lg p-10 h-full"
                style={{
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <h3
                  className="text-lg text-white mb-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  {persona.title}
                </h3>
                <p
                  className="text-sm mb-4"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.4)",
                    fontStyle: "italic",
                  }}
                >
                  {persona.subtitle}
                </p>
                <p
                  className="text-sm leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                    fontWeight: 400,
                  }}
                >
                  {persona.description}
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
// Comparison Section
// ---------------------------------------------------------------------------

function ComparisonCell({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <Check
        size={16}
        strokeWidth={2}
        style={{ color: "rgba(74,222,128,0.8)" }}
      />
    );
  }
  if (value === false) {
    return (
      <Minus
        size={16}
        strokeWidth={2}
        style={{ color: "rgba(255,255,255,0.15)" }}
      />
    );
  }
  return (
    <span
      className="text-[13px]"
      style={{
        fontFamily: "var(--font-dm-sans)",
        color: "rgba(255,255,255,0.5)",
      }}
    >
      {value}
    </span>
  );
}

function ComparisonSection() {
  return (
    <section className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-4xl">
        <FadeUp className="text-center">
          <SectionLabel>Why Magister</SectionLabel>
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
            Not another chatbot.
          </h2>
        </FadeUp>

        <FadeUp delay={0.15}>
          <div
            className="mt-16 overflow-x-auto rounded-xl"
            style={{
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <table
              className="w-full text-left"
              style={{ fontFamily: "var(--font-dm-sans)", minWidth: 560 }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <th
                    className="px-6 py-4 text-[13px] font-normal"
                    style={{ color: "rgba(255,255,255,0.3)" }}
                  />
                  <th
                    className="px-6 py-4 text-[13px] font-medium text-center"
                    style={{ color: "rgba(255,255,255,0.4)" }}
                  >
                    ChatGPT / Claude
                  </th>
                  <th
                    className="px-6 py-4 text-[13px] font-medium text-center text-white"
                  >
                    Magister
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row, i) => (
                  <tr
                    key={row.label}
                    style={{
                      borderBottom:
                        i < comparisonRows.length - 1
                          ? "1px solid rgba(255,255,255,0.04)"
                          : "none",
                    }}
                  >
                    <td
                      className="px-6 py-4 text-[14px]"
                      style={{ color: "rgba(255,255,255,0.6)" }}
                    >
                      {row.label}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex justify-center">
                        <ComparisonCell value={row.chatbot} />
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex justify-center">
                        <ComparisonCell value={row.magister} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pricing Section
// ---------------------------------------------------------------------------

const pricingPlans = [
  {
    name: "CMO",
    price: "$299",
    period: "/mo",
    description: "One autonomous marketing agent with 25 specialized skills.",
    cta: "Get early access",
    highlighted: true,
    badge: null,
  },
  {
    name: "CMO + Specialists",
    price: "$999",
    period: "/mo",
    description:
      "10+ agents working together — strategy, copy, SEO, ads, email, and more.",
    cta: "Get early access",
    highlighted: false,
    badge: null,
  },
  {
    name: "Custom Install",
    price: "$24,999",
    period: " one-time",
    description:
      "We set it up on your infrastructure. You own and host everything.",
    cta: "Get early access",
    highlighted: false,
    badge: null,
  },
];

function PricingSection() {
  return (
    <section id="pricing" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <FadeUp className="text-center">
          <SectionLabel>Pricing</SectionLabel>
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
            The marketing team you&apos;ve been putting off hiring.
          </h2>
        </FadeUp>

        <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-3">
          {pricingPlans.map((plan, i) => (
            <FadeUp key={plan.name} delay={0.1 * i}>
              <div
                className="relative flex flex-col rounded-xl p-8 h-full"
                style={{
                  border: plan.highlighted
                    ? "1px solid rgba(255,255,255,0.2)"
                    : "1px solid rgba(255,255,255,0.06)",
                  backgroundColor: plan.highlighted
                    ? "rgba(255,255,255,0.03)"
                    : "transparent",
                }}
              >
                {plan.badge && (
                  <span
                    className="absolute top-4 right-4 rounded-full px-3 py-1 text-[11px] uppercase"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      color: "rgba(255,255,255,0.5)",
                      backgroundColor: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }}
                  >
                    {plan.badge}
                  </span>
                )}

                <h3
                  className="text-lg text-white mb-4"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  {plan.name}
                </h3>

                <div className="mb-4 flex items-baseline gap-1">
                  <span
                    className="text-white"
                    style={{
                      fontFamily: "var(--font-instrument-serif)",
                      fontSize: "clamp(36px, 4vw, 48px)",
                      lineHeight: 1,
                      letterSpacing: "-0.02em",
                      fontWeight: 400,
                    }}
                  >
                    {plan.price}
                  </span>
                  <span
                    className="text-[15px]"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      color: "rgba(255,255,255,0.4)",
                    }}
                  >
                    {plan.period}
                  </span>
                </div>

                <p
                  className="text-sm leading-relaxed mb-8 flex-1"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                    fontWeight: 400,
                  }}
                >
                  {plan.description}
                </p>

                <button
                  onClick={() => {
                    const el = document.getElementById("request-access");
                    if (el) el.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={`w-full rounded-full py-3 text-[14px] font-medium transition-opacity duration-300 hover:opacity-90 ${
                    plan.highlighted
                      ? "bg-white text-black"
                      : "bg-transparent text-white"
                  }`}
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    border: plan.highlighted
                      ? "none"
                      : "1px solid rgba(255,255,255,0.15)",
                  }}
                >
                  {plan.cta}
                </button>
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FAQ Section
// ---------------------------------------------------------------------------

function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-2xl">
        <FadeUp className="text-center">
          <SectionLabel>FAQ</SectionLabel>
          <h2
            className="text-white mb-16"
            style={{
              fontFamily: "var(--font-instrument-serif)",
              fontSize: "clamp(32px, 4vw, 56px)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              fontWeight: 400,
            }}
          >
            Questions
          </h2>
        </FadeUp>

        <div className="flex flex-col">
          {faqItems.map((item, i) => (
            <FadeUp key={i} delay={0.06 * i}>
              <div
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <button
                  onClick={() =>
                    setOpenIndex(openIndex === i ? null : i)
                  }
                  className="flex w-full items-center justify-between py-6 text-left"
                >
                  <span
                    className="text-[15px] text-white pr-4"
                    style={{
                      fontFamily: "var(--font-dm-sans)",
                      fontWeight: 500,
                    }}
                  >
                    {item.question}
                  </span>
                  <ChevronDown
                    size={18}
                    strokeWidth={1.5}
                    className="shrink-0 transition-transform duration-300"
                    style={{
                      color: "rgba(255,255,255,0.3)",
                      transform:
                        openIndex === i ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                  />
                </button>
                <AnimatePresence>
                  {openIndex === i && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="overflow-hidden"
                    >
                      <p
                        className="pb-6 text-[14px] leading-relaxed"
                        style={{
                          fontFamily: "var(--font-dm-sans)",
                          color: "rgba(255,255,255,0.5)",
                        }}
                      >
                        {item.answer}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </FadeUp>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// About Section
// ---------------------------------------------------------------------------

function AboutSection() {
  const [repoStats, setRepoStats] = useState({ stars: 0, forks: 0 });

  useEffect(() => {
    fetch("https://api.github.com/repos/coreyhaines31/marketingskills")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setRepoStats({
            stars: data.stargazers_count ?? 0,
            forks: data.forks_count ?? 0,
          });
        }
      })
      .catch(() => {});
  }, []);

  const formatNumber = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

  return (
    <section id="about" className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-3xl">
        <FadeUp className="text-center">
          <SectionLabel>Built by marketers</SectionLabel>
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
            Not another AI tool built by people who&apos;ve never run a
            campaign.
          </h2>
        </FadeUp>

        <div className="mt-16 flex flex-col gap-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-12">
            <FadeUp delay={0.1}>
              <div className="text-center">
                <Image
                  src="/corey.jpeg"
                  alt="Corey Haines"
                  width={96}
                  height={96}
                  className="mx-auto mb-5 rounded-full object-cover"
                  style={{ filter: "grayscale(100%)", width: 96, height: 96 }}
                />
                <h3
                  className="text-lg text-white mb-2"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  Corey Haines
                </h3>
                <p
                  className="text-base leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                  }}
                >
                  Founder of{" "}
                  <a
                    href="https://conversionfactory.co"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 decoration-white/30 hover:decoration-white/60 transition-colors"
                    style={{ color: "rgba(255,255,255,0.7)" }}
                  >
                    Conversion Factory
                  </a>
                  , a SaaS marketing agency.
                  Creator of{" "}
                  <a
                    href="https://github.com/coreyhaines31/marketingskills"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 decoration-white/30 hover:decoration-white/60 transition-colors"
                    style={{ color: "rgba(255,255,255,0.7)" }}
                  >
                    Marketing Skills
                  </a>
                  , the most-starred open source repo for marketing AI agents
                  {repoStats.stars > 0 &&
                    ` (${formatNumber(repoStats.stars)} stars, ${formatNumber(repoStats.forks)} forks)`}
                  .
                </p>
              </div>
            </FadeUp>

            <FadeUp delay={0.2}>
              <div className="text-center">
                <Image
                  src="/elliot.jpeg"
                  alt="Elliot Eckholm"
                  width={96}
                  height={96}
                  className="mx-auto mb-5 rounded-full object-cover"
                  style={{ filter: "grayscale(100%)", width: 96, height: 96 }}
                />
                <h3
                  className="text-lg text-white mb-2"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    fontWeight: 600,
                  }}
                >
                  Elliot Eckholm
                </h3>
                <p
                  className="text-base leading-relaxed"
                  style={{
                    fontFamily: "var(--font-dm-sans)",
                    color: "rgba(255,255,255,0.5)",
                  }}
                >
                  Co-founder and OpenClaw power user. Has led machine learning
                  engineering for startups serving millions of users. Also
                  building{" "}
                  <a
                    href="https://swipewell.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 decoration-white/30 hover:decoration-white/60 transition-colors"
                    style={{ color: "rgba(255,255,255,0.7)" }}
                  >
                    SwipeWell
                  </a>
                  .
                </p>
              </div>
            </FadeUp>
          </div>

          <FadeUp delay={0.3}>
            <p
              className="text-center text-xl md:text-2xl mt-4"
              style={{
                fontFamily: "var(--font-instrument-serif)",
                color: "rgba(255,255,255,0.8)",
                fontStyle: "italic",
                fontWeight: 400,
              }}
            >
              &ldquo;We&apos;ve spent years doing SaaS marketing by hand.
              Magister is the tool we wish we had.&rdquo;
            </p>
          </FadeUp>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CTA Section
// ---------------------------------------------------------------------------

function CtaSection({
  onEmailSubmit,
}: {
  onEmailSubmit: (email: string) => Promise<{ success: boolean; error?: string }>;
}) {
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
            Ready to stop doing it all yourself?
          </h2>
          <p
            className="mx-auto mt-6 max-w-md text-base"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "rgba(255,255,255,0.6)",
              fontWeight: 400,
            }}
          >
            We&apos;re opening this up gradually. Drop your email and
            we&apos;ll be in touch.
          </p>
          <div className="mt-10 flex justify-center">
            <EmailForm onSubmit={onEmailSubmit} id="cta-email" />
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
          Powered by Claude Code &middot; Built on OpenClaw
        </p>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const [showSurvey, setShowSurvey] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");

  const handleEmailSubmit = async (
    email: string
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await insertWaitlistEmail(email);
    if (result.success) {
      setSubmittedEmail(email.toLowerCase().trim());
      setShowSurvey(true);
    }
    return result;
  };

  return (
    <main className="relative min-h-screen bg-black selection:bg-white/10">
      {/* Subtle grain texture */}
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
      <Hero onEmailSubmit={handleEmailSubmit} />
      <ProblemSection />
      <HowItWorksSection />
      <DemoSection />
      <SkillsSection />
      <IntegrationsSection />
      <PersonasSection />
      <ComparisonSection />
      <PricingSection />
      <AboutSection />
      <FaqSection />
      <CtaSection onEmailSubmit={handleEmailSubmit} />
      <Footer />

      <AnimatePresence>
        {showSurvey && (
          <SurveyPopup
            email={submittedEmail}
            onClose={() => setShowSurvey(false)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
