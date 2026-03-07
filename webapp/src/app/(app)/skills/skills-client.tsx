"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createClient } from "@/lib/supabase/client";
import {
  listSkills,
  installSkill,
  removeSkill,
  toggleSkill,
  createCustomSkill,
  type SkillEntry,
} from "@/lib/gateway";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL!;

const CATALOG_SKILLS = [
  {
    slug: "proactive-agent",
    name: "Proactive Agent",
    description:
      "Transform agents from task-followers into proactive partners that anticipate needs and continuously improve.",
  },
  {
    slug: "self-improving-agent",
    name: "Self-Improving Agent",
    description:
      "Enable your agent to learn from interactions and improve its own performance over time.",
  },
  {
    slug: "tavily-search",
    name: "Tavily Search",
    description:
      "Web search capability powered by Tavily API for real-time information retrieval.",
  },
  {
    slug: "gog",
    name: "GoG",
    description:
      "A versatile general-purpose skill by steipete for enhanced agent workflows.",
  },
  {
    slug: "agent-browser",
    name: "Agent Browser",
    description:
      "Give your agent the ability to browse the web, interact with pages, and extract information.",
  },
  {
    slug: "brave-search",
    name: "Brave Search",
    description:
      "Web search using the Brave Search API for privacy-focused information retrieval.",
  },
  {
    slug: "skill-creator",
    name: "Skill Creator",
    description:
      "Meta-skill that helps your agent create new skills on the fly.",
  },
  {
    slug: "frontend-design",
    name: "Frontend Design",
    description:
      "Create distinctive, production-grade frontend interfaces with high design quality.",
  },
  {
    slug: "slack",
    name: "Slack",
    description:
      "Slack integration for reading and sending messages, managing channels, and more.",
  },
  {
    slug: "automation-workflows",
    name: "Automation Workflows",
    description: "Build and run automated workflows and task sequences.",
  },
  {
    slug: "nano-pdf",
    name: "Nano PDF",
    description: "Read, parse, and extract content from PDF documents.",
  },
  {
    slug: "nano-banana-pro",
    name: "Nano Banana Pro",
    description: "Advanced image generation and processing capabilities.",
  },
  {
    slug: "elite-longterm-memory",
    name: "Elite Long-Term Memory",
    description:
      "Persistent memory system for agents to remember context across sessions.",
  },
];

export function SkillsClient({
  machineStatus,
}: {
  machineStatus: string | null;
}) {
  const [jwt, setJwt] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SkillEntry | null>(null);
  const [removing, setRemoving] = useState(false);

  // Custom skill dialog state
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customContent, setCustomContent] = useState("");
  const [customCreating, setCustomCreating] = useState(false);

  // Get JWT on mount
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setJwt(data.session?.access_token ?? null);
    });
  }, []);

  // Fetch skills
  const fetchSkills = useCallback(async () => {
    if (!jwt) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listSkills(GATEWAY_URL, jwt);
      setSkills(res.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [jwt]);

  useEffect(() => {
    if (jwt && machineStatus === "running") {
      fetchSkills();
    } else {
      setLoading(false);
    }
  }, [jwt, machineStatus, fetchSkills]);

  // Install a catalog skill
  const handleInstall = useCallback(
    async (slug: string) => {
      if (!jwt) return;
      setInstallingSlug(slug);
      setError(null);
      try {
        await installSkill(GATEWAY_URL, jwt, slug);
        await fetchSkills();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to install skill"
        );
      } finally {
        setInstallingSlug(null);
      }
    },
    [jwt, fetchSkills]
  );

  // Remove a skill
  const handleRemove = useCallback(async () => {
    if (!jwt || !removeTarget) return;
    setRemoving(true);
    setError(null);
    try {
      await removeSkill(GATEWAY_URL, jwt, removeTarget.name);
      setSkills((prev) => prev.filter((s) => s.name !== removeTarget.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove skill");
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  }, [jwt, removeTarget]);

  // Toggle a skill enabled/disabled
  const handleToggle = useCallback(
    async (skill: SkillEntry) => {
      if (!jwt) return;
      const newEnabled = !skill.enabled;
      // Optimistic update
      setSkills((prev) =>
        prev.map((s) =>
          s.name === skill.name ? { ...s, enabled: newEnabled } : s
        )
      );
      try {
        await toggleSkill(GATEWAY_URL, jwt, skill.name, newEnabled);
      } catch (err) {
        // Revert on failure
        setSkills((prev) =>
          prev.map((s) =>
            s.name === skill.name ? { ...s, enabled: skill.enabled } : s
          )
        );
        setError(
          err instanceof Error ? err.message : "Failed to toggle skill"
        );
      }
    },
    [jwt]
  );

  // Create custom skill
  const handleCreateCustom = useCallback(async () => {
    if (!jwt || !customName.trim()) return;
    setCustomCreating(true);
    setError(null);
    try {
      await createCustomSkill(GATEWAY_URL, jwt, customName.trim(), customContent);
      setCustomDialogOpen(false);
      setCustomName("");
      setCustomContent("");
      await fetchSkills();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create custom skill"
      );
    } finally {
      setCustomCreating(false);
    }
  }, [jwt, customName, customContent, fetchSkills]);

  // Check if a catalog skill is already installed
  const isInstalled = useCallback(
    (slug: string) => {
      return skills.some(
        (s) => s.name.toLowerCase() === slug.toLowerCase()
      );
    },
    [skills]
  );

  // ── Machine not running ─────────────────────────────────

  if (machineStatus !== "running") {
    return (
      <div className="flex h-[calc(100vh-3rem)] items-center justify-center">
        <div className="text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <h2 className="text-lg font-medium">Agent not running</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Start your agent from the Dashboard to manage skills.
          </p>
        </div>
      </div>
    );
  }

  // ── Main Layout ─────────────────────────────────────────

  return (
    <ScrollArea className="h-[calc(100vh-3rem)]">
      <div className="p-6 space-y-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setCustomDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              Custom Skill
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={fetchSkills}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* ── Installed Skills ───────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Installed Skills</h2>
          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No skills installed yet. Browse the catalog below to get
                started.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {skills.map((skill) => (
                <div
                  key={skill.name}
                  className="rounded-lg border border-border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg shrink-0">{skill.emoji}</span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium truncate">
                          {skill.name}
                        </h3>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {skill.source}
                        </span>
                      </div>
                    </div>
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={() => handleToggle(skill)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {skill.description}
                  </p>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                      onClick={() => setRemoveTarget(skill)}
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Skill Catalog ──────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Skill Catalog</h2>
          <p className="text-sm text-muted-foreground">
            Curated skills for your agent. Install with one click.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CATALOG_SKILLS.map((cs) => {
              const installed = isInstalled(cs.slug);
              const installing = installingSlug === cs.slug;
              return (
                <div
                  key={cs.slug}
                  className="rounded-lg border border-border bg-card p-4 space-y-3"
                >
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{cs.name}</h3>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {cs.slug}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {cs.description}
                  </p>
                  <div className="flex justify-end">
                    {installed ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        disabled
                      >
                        <Check className="h-3 w-3" />
                        Installed
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        disabled={installing}
                        onClick={() => handleInstall(cs.slug)}
                      >
                        {installing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        {installing ? "Installing..." : "Install"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* ── Custom Skill Dialog ────────────────────────── */}
      <Dialog
        open={customDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCustomDialogOpen(false);
            setCustomName("");
            setCustomContent("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Custom Skill</DialogTitle>
            <DialogDescription>
              Define a custom skill with a SKILL.md file that describes the
              skill&apos;s behavior.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="skill-name"
                className="text-sm font-medium"
              >
                Skill Name
              </label>
              <Input
                id="skill-name"
                placeholder="my-custom-skill"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="skill-content"
                className="text-sm font-medium"
              >
                SKILL.md Content
              </label>
              <textarea
                id="skill-content"
                className="w-full min-h-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                placeholder={"# My Skill\n\nDescribe what this skill does..."}
                value={customContent}
                onChange={(e) => setCustomContent(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCustomDialogOpen(false);
                setCustomName("");
                setCustomContent("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateCustom}
              disabled={!customName.trim() || customCreating}
            >
              {customCreating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Remove Confirmation ────────────────────────── */}
      <Dialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove skill?</DialogTitle>
            <DialogDescription>
              This will remove{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {removeTarget?.name}
              </code>{" "}
              from your agent. You can reinstall it later from the catalog.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
