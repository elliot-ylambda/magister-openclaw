"use client";

import { load, trackPageview } from "fathom-client";
import { useEffect, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";

function FathomTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    load("XVAOIBYN", {
      auto: false,
      includedDomains: ["magistermarketing.com"],
    });
  }, []);

  useEffect(() => {
    trackPageview();
  }, [pathname, searchParams]);

  return null;
}

export default function Fathom() {
  return (
    <Suspense fallback={null}>
      <FathomTracker />
    </Suspense>
  );
}
