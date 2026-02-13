"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "backdrop-blur-md bg-midnight/80 border-b border-white/5"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <a
          href="#"
          className="flex items-center gap-2 font-[family-name:var(--font-space-grotesk)] font-bold text-xl text-white"
        >
          <Image src="/magister-logo-white.svg" alt="Magister Marketing" width={32} height={35} />
          <span>Magister</span>
        </a>
        <Button
          className="bg-amber-accent hover:bg-orange-accent text-black font-semibold cursor-pointer"
          onClick={() => {
            document
              .getElementById("waitlist")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Join Waitlist
        </Button>
      </div>
    </nav>
  );
}
