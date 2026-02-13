"use client";

import { motion } from "motion/react";
import { SectionLabel } from "@/components/section-label";
import { ClawMarks } from "@/components/claw-marks";

const steps = [
  {
    number: "01",
    title: "Deploy",
    description:
      "Install Magister Marketing and connect your existing tools and platforms.",
  },
  {
    number: "02",
    title: "Configure",
    description:
      "Choose which agents to activate and set your brand guidelines and goals.",
  },
  {
    number: "03",
    title: "Monitor",
    description:
      "Your agents work autonomously while you track progress through a unified dashboard.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 md:py-32 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <SectionLabel>The Process</SectionLabel>
          <h2 className="font-[family-name:var(--font-space-grotesk)] text-3xl md:text-4xl font-bold text-white">
            From setup to autopilot in three steps.
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
          {steps.map((step, index) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: index * 0.15, duration: 0.5 }}
              className="flex flex-col items-start"
            >
              <span className="font-[family-name:var(--font-space-grotesk)] text-5xl font-bold text-amber-accent">
                {step.number}
              </span>
              <ClawMarks className="my-3 scale-75 origin-left" />
              <h3 className="text-xl font-semibold text-white mb-2">
                {step.title}
              </h3>
              <p className="text-gray-400">{step.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
