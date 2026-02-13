import { Nav } from "@/components/nav";
import { Hero } from "@/components/hero";
import { Agents } from "@/components/agents";
import { HowItWorks } from "@/components/how-it-works";
import { Credibility } from "@/components/credibility";
import { Waitlist } from "@/components/waitlist";
import { Footer } from "@/components/footer";
import { ClawMarks } from "@/components/claw-marks";

export default function Home() {
  return (
    <main className="bg-midnight text-white min-h-screen">
      <Nav />
      <Hero />
      <ClawMarks className="my-16" />
      <Agents />
      <ClawMarks className="my-16" />
      <HowItWorks />
      <ClawMarks className="my-16" />
      <Credibility />
      <ClawMarks className="my-16" />
      <Waitlist />
      <Footer />
    </main>
  );
}
