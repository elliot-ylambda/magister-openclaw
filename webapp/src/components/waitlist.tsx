"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Glow } from "@/components/glow";

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.includes("@") || !email.includes(".")) return;
    console.log("Waitlist signup:", email);
    setSubmitted(true);
  };

  return (
    <section id="waitlist" className="relative py-24 md:py-32 px-6">
      {/* Background glow */}
      <Glow className="w-[800px] h-[500px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-50" />

      <div className="relative z-10 max-w-7xl mx-auto text-center">
        <h2 className="font-[family-name:var(--font-space-grotesk)] text-3xl md:text-4xl font-bold text-white mb-4">
          Ready to deploy your team?
        </h2>
        <p className="text-gray-400 mb-8 max-w-lg mx-auto">
          Join the waitlist for early access. We&apos;re onboarding teams in
          batches.
        </p>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
        >
          <Input
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitted}
            className="flex-1 bg-white/5 border-white/10 text-white placeholder:text-gray-500 h-11 focus-visible:ring-amber-accent/50 focus-visible:border-amber-accent/50"
          />
          <Button
            type="submit"
            disabled={submitted}
            className={`h-11 px-6 font-semibold cursor-pointer transition-colors duration-300 ${
              submitted
                ? "bg-green-500 hover:bg-green-500 text-white"
                : "bg-amber-accent hover:bg-orange-accent text-black"
            }`}
          >
            {submitted ? "You're on the list!" : "Get Early Access"}
          </Button>
        </form>

        <p className="text-xs text-gray-500 mt-4">
          No spam. Unsubscribe anytime.
        </p>
      </div>
    </section>
  );
}
