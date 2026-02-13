"use client";

import { motion } from "motion/react";
import {
  PenTool,
  Search,
  Share2,
  Radar,
  Star,
  BarChart3,
} from "lucide-react";
import { SectionLabel } from "@/components/section-label";

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
    description:
      "Monitors and responds to reviews across every platform.",
  },
  {
    icon: BarChart3,
    name: "Analytics Decoder",
    description:
      "Turns raw data into actionable growth insights and reports.",
  },
];

function StatusDot() {
  return (
    <span className="absolute top-4 right-4 flex h-2 w-2">
      <span
        className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"
        style={{
          animation:
            "status-ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite",
        }}
      />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
    </span>
  );
}

export function Agents() {
  return (
    <section id="agents" className="py-24 md:py-32 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <SectionLabel>The Team</SectionLabel>
          <h2 className="font-[family-name:var(--font-space-grotesk)] text-3xl md:text-4xl font-bold text-white">
            Six agents. Every marketing function.
            <br className="hidden sm:block" /> Zero overhead.
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents.map((agent, index) => {
            const Icon = agent.icon;
            return (
              <motion.div
                key={agent.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
              >
                <div
                  className="relative rounded-xl p-6 bg-white/5 border border-white/10 hover:border-amber-accent/50 hover:shadow-lg hover:shadow-amber-accent/5 hover:scale-[1.02] transition-all duration-300"
                  style={{
                    borderLeftWidth: undefined,
                  }}
                >
                  {/* Mobile amber left border accent */}
                  <div
                    className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full lg:hidden"
                    style={{
                      background:
                        "linear-gradient(to bottom, #f59e0b, #ea580c)",
                    }}
                  />
                  <StatusDot />
                  <div className="flex flex-col gap-3">
                    <Icon className="h-6 w-6 text-amber-accent" />
                    <h3 className="font-semibold text-white">{agent.name}</h3>
                    <p className="text-sm text-gray-400">
                      {agent.description}
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
