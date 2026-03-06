import Link from 'next/link';
import Image from 'next/image';
import { Monitor, Shield, Globe, ArrowRight } from 'lucide-react';

export default function ExtensionPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Nav */}
      <nav className="h-[72px] flex items-center border-b border-border/40">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 md:px-10">
          <Link href="/" className="flex items-center gap-2.5">
            <Image src="/magister-logo-white.svg" alt="Magister" width={28} height={30} />
            <span className="text-[15px] font-medium text-white tracking-[0.12em] uppercase">
              Magister
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-4 py-1.5 text-sm text-muted-foreground">
          <Monitor className="h-4 w-4" />
          Chrome Extension
        </div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Control Your Browser
          <br />
          <span className="text-muted-foreground">with Magister</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          Let your AI marketing agent interact with real websites — manage ad campaigns,
          update CMS content, analyze competitor pages, and more, all through your own browser.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <a
            href="#install"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Get the Extension
            <ArrowRight className="h-4 w-4" />
          </a>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
          >
            Go to Settings
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight mb-12">
          How it works
        </h2>
        <div className="grid gap-8 md:grid-cols-3">
          {[
            {
              step: '01',
              title: 'Install the extension',
              description: 'Add Magister Browser Control to Chrome from the Web Store or load it as an unpacked extension.',
            },
            {
              step: '02',
              title: 'Connect with a token',
              description: 'Generate a connection token in your Magister settings and paste it into the extension to link your browser.',
            },
            {
              step: '03',
              title: 'Let your agent work',
              description: 'Click the toolbar icon on any tab to attach it. Your agent can now see and interact with that page.',
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-xl border border-border/60 bg-card p-6 space-y-3"
            >
              <span className="text-sm font-mono text-muted-foreground">{item.step}</span>
              <h3 className="text-lg font-medium">{item.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Security */}
      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight mb-12">
          Built with security in mind
        </h2>
        <div className="grid gap-6 md:grid-cols-3">
          {[
            {
              icon: Shield,
              title: 'Encrypted connection',
              description: 'All communication between your browser and agent is encrypted via WSS through the Magister gateway.',
            },
            {
              icon: Globe,
              title: 'URL allowlist',
              description: 'Restrict which domains your agent can access. Only approved sites will be reachable.',
            },
            {
              icon: Monitor,
              title: 'Read-only mode',
              description: 'Enable read-only to let your agent view pages without being able to click, type, or navigate.',
            },
          ].map((item) => (
            <div
              key={item.title}
              className="flex gap-4 rounded-xl border border-border/60 bg-card p-5"
            >
              <item.icon className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-medium">{item.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section id="install" className="mx-auto max-w-3xl px-6 py-16 text-center">
        <div className="rounded-2xl border border-border/60 bg-card p-10">
          <h2 className="text-2xl font-semibold tracking-tight">Ready to get started?</h2>
          <p className="mt-3 text-muted-foreground">
            Install the extension and connect it to your Magister account in under a minute.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4 flex-wrap">
            <a
              href="#"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Install Extension
              <ArrowRight className="h-4 w-4" />
            </a>
            <Link
              href="/settings"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Already installed? Go to Settings
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/40 py-8 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} Magister Marketing. All rights reserved.</p>
      </footer>
    </div>
  );
}
