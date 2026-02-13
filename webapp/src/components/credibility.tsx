"use client";

import { motion } from "motion/react";
import { Shield, Cpu, Users } from "lucide-react";
import { SectionLabel } from "@/components/section-label";

const pillars = [
  {
    icon: Shield,
    title: "Open Source",
    description:
      "Fully transparent codebase. Audit every decision your agents make.",
  },
  {
    icon: Cpu,
    title: "Local-First",
    description:
      "Your data never leaves your infrastructure. Complete privacy by default.",
  },
  {
    icon: Users,
    title: "6 Specialized Agents",
    description:
      "Purpose-built agents that outperform generic AI on every marketing task.",
  },
];

export function Credibility() {
  return (
    <section className="py-24 md:py-32 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <SectionLabel>Why Magister Marketing</SectionLabel>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
          {pillars.map((pillar, index) => {
            const Icon = pillar.icon;
            return (
              <motion.div
                key={pillar.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className="bg-white/[0.02] rounded-2xl p-8 border border-white/5 text-center"
              >
                <Icon className="h-8 w-8 text-amber-accent mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-white mb-2">
                  {pillar.title}
                </h3>
                <p className="text-sm text-gray-400">{pillar.description}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
