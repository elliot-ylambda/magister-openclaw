# Skills Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a top-level `/skills` page where users can browse a catalog of ClawHub skills, install/remove them on their agent's machine, toggle skills on/off, and create custom skills.

**Architecture:** The gateway gets a new `skills.py` route that proxies skill operations to user Fly machines via the exec API (same pattern as `files.py`). Skills are filesystem-based on the machine — we read config from `~/.openclaw/openclaw.json`, list skill directories, and write SKILL.md files for custom skills. The webapp gets a new `/skills` page with catalog, installed skills, and custom skill creation. Catalog data is fetched from ClawHub at runtime via `npx clawhub search` on the user's machine (since `clawhub` CLI is not pre-installed, we use `npx`).

**Tech Stack:** FastAPI (gateway), Next.js/React/TypeScript (webapp), Fly Machines exec API, shadcn/ui components, ClawHub CLI via npx

---

## Task 1: Gateway — Skills Route (List & Status)

**Files:**
- Create: `gateway/app/routes/skills.py`
- Modify: `gateway/app/main.py` (register router)
- Modify: `gateway/app/models.py` (add Pydantic models)

**Step 1: Add Pydantic models**

Add to `gateway/app/models.py`:

```python
class SkillEntry(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    source: str = ""  # "workspace", "managed", "bundled"
    emoji: str = ""
    homepage: str = ""


class SkillListResponse(BaseModel):
    skills: list[SkillEntry]


class SkillInstallRequest(BaseModel):
    slug: str  # ClawHub slug e.g. "steipete/frontend-design"


class CustomSkillRequest(BaseModel):
    name: str  # Skill directory name (kebab-case)
    content: str  # Full SKILL.md content


class SkillToggleRequest(BaseModel):
    enabled: bool
```

**Step 2: Create `gateway/app/routes/skills.py`**

Follow the exact pattern of `files.py`:
- Same router factory signature: `create_skills_router(fly, supabase, *, jwt_secret, api_key, supabase_url)`
- Same `_resolve_user` and `_get_running_machine` helpers (copy from files.py)
- Same `_exec_on_machine` helper
- Reuse `_validate_path` is NOT needed — skills paths are constructed server-side

```python
"""Skills management endpoints: list, install, remove, toggle, create custom.

Executes commands on user Fly machines via the Machines exec API.
JWT auth only (user-facing).
"""

from __future__ import annotations

import base64
import json
import logging
import shlex

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.models import MachineStatus, SkillEntry, SkillListResponse, SkillInstallRequest, CustomSkillRequest, SkillToggleRequest
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.skills")

SKILLS_DIR = "/data/.openclaw/skills/"
MANAGED_SKILLS_DIR = "/root/.openclaw/skills/"
CONFIG_PATH = "/root/.openclaw/openclaw.json"


async def _exec_on_machine(
    fly: FlyClient, app: str, machine_id: str, cmd: list[str], *, timeout: int = 30
) -> dict:
    """Run exec and map common errors to HTTP codes."""
    result = await fly.exec_command(app, machine_id, cmd, timeout=timeout)
    stderr = result.get("stderr", "")
    exit_code = result.get("exit_code", 0)
    if exit_code != 0:
        if "No such file or directory" in stderr:
            raise HTTPException(status_code=404, detail="Skill not found")
        raise HTTPException(status_code=500, detail=f"Command failed: {stderr.strip()}")
    return result


def create_skills_router(
    fly: FlyClient,
    supabase: SupabaseService,
    *,
    jwt_secret: str,
    api_key: str,
    supabase_url: str = "",
) -> APIRouter:
    router = APIRouter()

    jwks_client = None
    if supabase_url:
        from jwt import PyJWKClient
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)

    async def _resolve_user(request: Request) -> str:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = auth[7:]
        try:
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg", "HS256")
            if alg == "ES256" and jwks_client:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = pyjwt.decode(token, signing_key.key, algorithms=["ES256"], audience="authenticated")
            else:
                payload = pyjwt.decode(token, jwt_secret, algorithms=["HS256"], audience="authenticated")
        except pyjwt.exceptions.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="JWT missing sub claim")
        return user_id

    async def _get_running_machine(user_id: str):
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")
        if machine.status != MachineStatus.running:
            raise HTTPException(status_code=409, detail="Machine must be running to manage skills. Start your agent first.")
        if not machine.fly_machine_id:
            raise HTTPException(status_code=409, detail="Machine has no Fly instance")
        return machine

    # ── List installed skills ──────────────────────────────────

    @router.get("/skills")
    async def list_skills(request: Request):
        """List all skills installed on the user's machine.

        Reads skill directories and merges with openclaw.json config
        to determine enabled/disabled state.
        """
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        app_name = machine.fly_app_name
        machine_id = machine.fly_machine_id

        # Read openclaw.json for enabled/disabled state
        config = {}
        try:
            cfg_result = await _exec_on_machine(fly, app_name, machine_id, ["cat", CONFIG_PATH])
            config = json.loads(cfg_result.get("stdout", "{}"))
        except Exception:
            pass  # Config may not exist yet

        skill_entries = config.get("skills", {}).get("entries", {})

        # Scan workspace skills directory
        skills: list[dict] = []
        for skills_dir, source in [(SKILLS_DIR, "workspace"), (MANAGED_SKILLS_DIR, "managed")]:
            try:
                result = await _exec_on_machine(
                    fly, app_name, machine_id,
                    ["bash", "-c", f"ls -1 {shlex.quote(skills_dir)} 2>/dev/null || true"],
                )
                stdout = result.get("stdout", "").strip()
                if not stdout:
                    continue
                for skill_name in stdout.split("\n"):
                    skill_name = skill_name.strip()
                    if not skill_name:
                        continue
                    # Read SKILL.md frontmatter for metadata
                    skill_md_path = f"{skills_dir}{skill_name}/SKILL.md"
                    try:
                        md_result = await _exec_on_machine(
                            fly, app_name, machine_id,
                            ["head", "-30", skill_md_path],
                        )
                        md_content = md_result.get("stdout", "")
                        description = _extract_description(md_content)
                        emoji = _extract_field(md_content, "emoji")
                    except Exception:
                        description = ""
                        emoji = ""

                    # Check config for enabled state
                    cfg = skill_entries.get(skill_name, {})
                    enabled = cfg.get("enabled", True)

                    skills.append({
                        "name": skill_name,
                        "description": description,
                        "enabled": enabled,
                        "source": source,
                        "emoji": emoji,
                        "homepage": "",
                    })
            except Exception:
                continue

        return SkillListResponse(skills=[SkillEntry(**s) for s in skills])

    # ── Install from ClawHub ──────────────────────────────────

    @router.post("/skills/install")
    async def install_skill(request: Request, body: SkillInstallRequest):
        """Install a skill from ClawHub using npx clawhub install."""
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        safe_slug = shlex.quote(body.slug)
        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"cd /data/.openclaw && npx -y clawhub install {safe_slug} --yes 2>&1"],
            timeout=60,
        )

        stdout = result.get("stdout", "")
        logger.info(f"[skills] User {user_id} installed {body.slug}: {stdout[:200]}")
        return {"status": "ok", "slug": body.slug, "output": stdout}

    # ── Remove skill ──────────────────────────────────────────

    @router.delete("/skills/{skill_name}")
    async def remove_skill(request: Request, skill_name: str):
        """Remove a skill by deleting its directory."""
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        # Only allow removing from workspace skills dir
        safe_name = shlex.quote(skill_name)
        skill_path = f"{SKILLS_DIR}{skill_name}"
        safe_path = shlex.quote(skill_path)

        # Verify it exists first
        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["test", "-d", skill_path],
        )

        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["rm", "-rf", skill_path],
        )

        logger.info(f"[skills] User {user_id} removed skill {skill_name}")
        return {"status": "ok", "name": skill_name}

    # ── Toggle skill enabled/disabled ─────────────────────────

    @router.patch("/skills/{skill_name}")
    async def toggle_skill(request: Request, skill_name: str, body: SkillToggleRequest):
        """Enable or disable a skill by updating openclaw.json config."""
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        app_name = machine.fly_app_name
        machine_id = machine.fly_machine_id

        # Read existing config
        config = {}
        try:
            cfg_result = await _exec_on_machine(fly, app_name, machine_id, ["cat", CONFIG_PATH])
            config = json.loads(cfg_result.get("stdout", "{}"))
        except Exception:
            pass

        # Update the skill entry
        if "skills" not in config:
            config["skills"] = {}
        if "entries" not in config["skills"]:
            config["skills"]["entries"] = {}
        if skill_name not in config["skills"]["entries"]:
            config["skills"]["entries"][skill_name] = {}
        config["skills"]["entries"][skill_name]["enabled"] = body.enabled

        # Write config back
        config_json = json.dumps(config, indent=2)
        b64 = base64.b64encode(config_json.encode()).decode()
        await _exec_on_machine(
            fly, app_name, machine_id,
            ["bash", "-c", f"echo {shlex.quote(b64)} | base64 -d > {shlex.quote(CONFIG_PATH)}"],
        )

        logger.info(f"[skills] User {user_id} {'enabled' if body.enabled else 'disabled'} {skill_name}")
        return {"status": "ok", "name": skill_name, "enabled": body.enabled}

    # ── Create custom skill ──────────────────────────────────

    @router.post("/skills/custom")
    async def create_custom_skill(request: Request, body: CustomSkillRequest):
        """Create a custom skill by writing a SKILL.md file."""
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        # Validate name (kebab-case, alphanumeric + hyphens)
        import re
        if not re.match(r'^[a-z0-9][a-z0-9-]*[a-z0-9]$', body.name) and len(body.name) > 1:
            raise HTTPException(status_code=400, detail="Skill name must be kebab-case (lowercase letters, numbers, hyphens)")
        if len(body.name) < 2 or len(body.name) > 64:
            raise HTTPException(status_code=400, detail="Skill name must be 2-64 characters")

        skill_dir = f"{SKILLS_DIR}{body.name}"
        skill_md = f"{skill_dir}/SKILL.md"
        safe_dir = shlex.quote(skill_dir)
        safe_md = shlex.quote(skill_md)

        b64_content = base64.b64encode(body.content.encode("utf-8")).decode("ascii")

        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"mkdir -p {safe_dir} && echo {shlex.quote(b64_content)} | base64 -d > {safe_md}"],
        )

        logger.info(f"[skills] User {user_id} created custom skill {body.name}")
        return {"status": "ok", "name": body.name}

    # ── Search ClawHub catalog ────────────────────────────────

    @router.get("/skills/catalog")
    async def search_catalog(request: Request, q: str = ""):
        """Search ClawHub for available skills using npx clawhub search."""
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        safe_query = shlex.quote(q) if q else '""'
        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"npx -y clawhub search {safe_query} --json 2>/dev/null || echo '[]'"],
            timeout=30,
        )

        stdout = result.get("stdout", "[]").strip()
        try:
            catalog = json.loads(stdout)
        except json.JSONDecodeError:
            catalog = []

        return {"skills": catalog}

    return router


def _extract_description(md_content: str) -> str:
    """Extract description from SKILL.md YAML frontmatter."""
    if not md_content.startswith("---"):
        # No frontmatter — use first non-empty, non-heading line
        for line in md_content.split("\n"):
            line = line.strip()
            if line and not line.startswith("#") and not line.startswith("---"):
                return line[:200]
        return ""
    parts = md_content.split("---", 2)
    if len(parts) < 3:
        return ""
    frontmatter = parts[1]
    for line in frontmatter.split("\n"):
        if line.strip().startswith("description:"):
            desc = line.split(":", 1)[1].strip().strip('"').strip("'")
            return desc[:200]
    return ""


def _extract_field(md_content: str, field: str) -> str:
    """Extract a simple field from SKILL.md YAML frontmatter."""
    if not md_content.startswith("---"):
        return ""
    parts = md_content.split("---", 2)
    if len(parts) < 3:
        return ""
    for line in parts[1].split("\n"):
        if line.strip().startswith(f"{field}:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""
```

**Step 3: Register the router in `main.py`**

Add import and router registration following the existing pattern:

```python
from app.routes.skills import create_skills_router

# In lifespan(), after files router:
app.include_router(
    create_skills_router(
        fly, supabase,
        jwt_secret=settings.supabase_jwt_secret,
        api_key=settings.gateway_api_key,
        supabase_url=settings.supabase_url,
    ),
    prefix="/api",
)
```

**Step 4: Run gateway lint**

Run: `make gateway-lint`
Expected: PASS

**Step 5: Commit**

```bash
git add gateway/app/routes/skills.py gateway/app/main.py gateway/app/models.py
git commit -m "feat: add skills management gateway endpoints"
```

---

## Task 2: Webapp — Gateway Client Functions

**Files:**
- Modify: `webapp/src/lib/gateway.ts`

**Step 1: Add types and functions**

Append to `gateway.ts`:

```typescript
// ── Skills operations ────────────────────────────────────────

export type SkillEntry = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  emoji: string;
  homepage: string;
};

export type SkillListResponse = { skills: SkillEntry[] };

export type CatalogSkill = {
  slug: string;
  name: string;
  description: string;
  author: string;
  version: string;
  downloads?: number;
};

async function skillRequest<T>(
  gatewayUrl: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${gatewayUrl}/api${path}`, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? `Skills operation failed (${res.status})`);
  }
  return res.json();
}

export function listSkills(gatewayUrl: string, jwt: string) {
  return skillRequest<SkillListResponse>(gatewayUrl, jwt, "GET", "/skills");
}

export function installSkill(gatewayUrl: string, jwt: string, slug: string) {
  return skillRequest<{ status: string; slug: string; output: string }>(
    gatewayUrl, jwt, "POST", "/skills/install", { slug }
  );
}

export function removeSkill(gatewayUrl: string, jwt: string, name: string) {
  return skillRequest<{ status: string; name: string }>(
    gatewayUrl, jwt, "DELETE", `/skills/${encodeURIComponent(name)}`
  );
}

export function toggleSkill(gatewayUrl: string, jwt: string, name: string, enabled: boolean) {
  return skillRequest<{ status: string; name: string; enabled: boolean }>(
    gatewayUrl, jwt, "PATCH", `/skills/${encodeURIComponent(name)}`, { enabled }
  );
}

export function createCustomSkill(
  gatewayUrl: string, jwt: string, name: string, content: string
) {
  return skillRequest<{ status: string; name: string }>(
    gatewayUrl, jwt, "POST", "/skills/custom", { name, content }
  );
}

export function searchCatalog(gatewayUrl: string, jwt: string, query: string = "") {
  return skillRequest<{ skills: CatalogSkill[] }>(
    gatewayUrl, jwt, "GET", `/skills/catalog?q=${encodeURIComponent(query)}`
  );
}
```

**Step 2: Run webapp lint**

Run: `cd webapp && pnpm lint`
Expected: PASS

**Step 3: Commit**

```bash
git add webapp/src/lib/gateway.ts
git commit -m "feat: add skills gateway client functions"
```

---

## Task 3: Webapp — Skills Page (Server + Client Components)

**Files:**
- Create: `webapp/src/app/(app)/skills/page.tsx`
- Create: `webapp/src/app/(app)/skills/skills-client.tsx`
- Create: `webapp/src/app/(app)/skills/loading.tsx`

**Step 1: Create loading skeleton**

Create `webapp/src/app/(app)/skills/loading.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function SkillsLoading() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
```

**Step 2: Create server page**

Create `webapp/src/app/(app)/skills/page.tsx`:

```tsx
import { checkAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SkillsClient } from "./skills-client";

export default async function SkillsPage() {
  const { user } = await checkAccess();

  const supabase = await createClient();
  const { data: machine } = await supabase
    .from("user_machines_safe")
    .select("status")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  return <SkillsClient machineStatus={machine?.status ?? null} />;
}
```

**Step 3: Create the client component**

Create `webapp/src/app/(app)/skills/skills-client.tsx`.

This is the largest piece. The component has three sections:
1. **Installed Skills** — cards with toggle switch and remove button
2. **Skill Catalog** — curated ClawHub skills with install buttons
3. **Custom Skill** — form with name input and SKILL.md textarea

The curated catalog is a hardcoded list of the 12 skills provided. We display them as cards. When the user clicks "Install", we call `installSkill()` which runs `npx clawhub install <slug>` on their machine. We also attempt to fetch live data from ClawHub via the catalog endpoint for descriptions, but fall back to hardcoded descriptions.

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  Plus,
  Power,
  PowerOff,
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

// Curated catalog — these are always shown regardless of ClawHub search
const CATALOG_SKILLS = [
  { slug: "halthelobster/proactive-agent", name: "Proactive Agent", description: "Transform agents from task-followers into proactive partners that anticipate needs and continuously improve." },
  { slug: "pskoett/self-improving-agent", name: "Self-Improving Agent", description: "Enable your agent to learn from interactions and improve its own performance over time." },
  { slug: "arun-8687/tavily-search", name: "Tavily Search", description: "Web search capability powered by Tavily API for real-time information retrieval." },
  { slug: "steipete/gog", name: "GoG", description: "A versatile general-purpose skill by steipete for enhanced agent workflows." },
  { slug: "TheSethRose/agent-browser", name: "Agent Browser", description: "Give your agent the ability to browse the web, interact with pages, and extract information." },
  { slug: "steipete/brave-search", name: "Brave Search", description: "Web search using the Brave Search API for privacy-focused information retrieval." },
  { slug: "chindden/skill-creator", name: "Skill Creator", description: "Meta-skill that helps your agent create new skills on the fly." },
  { slug: "steipete/frontend-design", name: "Frontend Design", description: "Create distinctive, production-grade frontend interfaces with high design quality." },
  { slug: "steipete/slack", name: "Slack", description: "Slack integration for reading and sending messages, managing channels, and more." },
  { slug: "JK-0001/automation-workflows", name: "Automation Workflows", description: "Build and run automated workflows and task sequences." },
  { slug: "steipete/nano-pdf", name: "Nano PDF", description: "Read, parse, and extract content from PDF documents." },
  { slug: "steipete/nano-banana-pro", name: "Nano Banana Pro", description: "Advanced image generation and processing capabilities." },
  { slug: "NextFrontierBuilds/elite-longterm-memory", name: "Elite Long-Term Memory", description: "Persistent memory system for agents to remember context across sessions." },
];

export function SkillsClient({ machineStatus }: { machineStatus: string | null }) {
  const [jwt, setJwt] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Action states
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  // Custom skill dialog
  const [customDialog, setCustomDialog] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customContent, setCustomContent] = useState("");
  const [customSaving, setCustomSaving] = useState(false);

  // Remove confirmation
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  // Get JWT
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setJwt(data.session?.access_token ?? null);
    });
  }, []);

  // Load installed skills
  const loadSkills = useCallback(async () => {
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
    if (jwt && machineStatus === "running") loadSkills();
    else setLoading(false);
  }, [jwt, machineStatus, loadSkills]);

  // Install from catalog
  const handleInstall = useCallback(async (slug: string) => {
    if (!jwt) return;
    setInstalling(slug);
    setError(null);
    try {
      await installSkill(GATEWAY_URL, jwt, slug);
      await loadSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(null);
    }
  }, [jwt, loadSkills]);

  // Remove skill
  const handleRemove = useCallback(async () => {
    if (!jwt || !removeTarget) return;
    setRemoving(removeTarget);
    setError(null);
    try {
      await removeSkill(GATEWAY_URL, jwt, removeTarget);
      setSkills((prev) => prev.filter((s) => s.name !== removeTarget));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove skill");
    } finally {
      setRemoving(null);
      setRemoveTarget(null);
    }
  }, [jwt, removeTarget]);

  // Toggle enabled/disabled
  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    if (!jwt) return;
    setToggling(name);
    try {
      await toggleSkill(GATEWAY_URL, jwt, name, enabled);
      setSkills((prev) =>
        prev.map((s) => (s.name === name ? { ...s, enabled } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle skill");
    } finally {
      setToggling(null);
    }
  }, [jwt]);

  // Create custom skill
  const handleCreateCustom = useCallback(async () => {
    if (!jwt || !customName.trim() || !customContent.trim()) return;
    setCustomSaving(true);
    setError(null);
    try {
      await createCustomSkill(GATEWAY_URL, jwt, customName.trim(), customContent);
      setCustomDialog(false);
      setCustomName("");
      setCustomContent("");
      await loadSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCustomSaving(false);
    }
  }, [jwt, customName, customContent, loadSkills]);

  // Which catalog skills are already installed?
  const installedNames = new Set(skills.map((s) => s.name));

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

  return (
    <ScrollArea className="h-[calc(100vh-3rem)]">
      <div className="p-6 max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Extend your agent&apos;s capabilities with skills
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setCustomDialog(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              Custom Skill
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={loadSkills}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <Button variant="ghost" size="icon" className="h-5 w-5 text-destructive" onClick={() => setError(null)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* ── Installed Skills ──────────────────────────────── */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Installed Skills
          </h2>
          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <Zap className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No skills installed yet. Browse the catalog below to get started.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {skills.map((skill) => (
                <div
                  key={skill.name}
                  className={`rounded-lg border border-border p-4 space-y-2 transition-opacity ${
                    !skill.enabled ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {skill.emoji && <span className="text-base">{skill.emoji}</span>}
                        <h3 className="text-sm font-medium truncate">{skill.name}</h3>
                      </div>
                      <span className="text-[10px] text-muted-foreground/60 uppercase">
                        {skill.source}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => handleToggle(skill.name, checked)}
                        disabled={toggling === skill.name}
                        className="scale-75"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => setRemoveTarget(skill.name)}
                        disabled={removing === skill.name}
                      >
                        {removing === skill.name ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                  {skill.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {skill.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Skill Catalog ────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Skill Catalog
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CATALOG_SKILLS.map((cat) => {
              const skillName = cat.slug.split("/")[1];
              const isInstalled = installedNames.has(skillName);
              const isInstalling = installing === cat.slug;

              return (
                <div
                  key={cat.slug}
                  className="rounded-lg border border-border p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium truncate">{cat.name}</h3>
                      <span className="text-[10px] text-muted-foreground/60">
                        {cat.slug}
                      </span>
                    </div>
                    {isInstalled ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-500 shrink-0">
                        <Check className="h-3 w-3" />
                        Installed
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs shrink-0"
                        onClick={() => handleInstall(cat.slug)}
                        disabled={isInstalling}
                      >
                        {isInstalling ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        Install
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {cat.description}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Custom Skill Dialog ──────────────────────────── */}
        <Dialog open={customDialog} onOpenChange={setCustomDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Custom Skill</DialogTitle>
              <DialogDescription>
                Write a SKILL.md for your agent. Use YAML frontmatter for metadata.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Skill Name (kebab-case)
                </label>
                <Input
                  placeholder="my-custom-skill"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  SKILL.md Content
                </label>
                <textarea
                  className="w-full h-64 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                  placeholder={`---\nname: my-custom-skill\ndescription: What this skill does\n---\n\n# My Custom Skill\n\nInstructions for the agent...`}
                  value={customContent}
                  onChange={(e) => setCustomContent(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCustomDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreateCustom}
                disabled={!customName.trim() || !customContent.trim() || customSaving}
              >
                {customSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <Plus className="h-4 w-4 mr-1.5" />
                )}
                Create Skill
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Remove Confirmation ─────────────────────────── */}
        <Dialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove skill?</DialogTitle>
              <DialogDescription>
                This will permanently delete the skill{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">{removeTarget}</code>{" "}
                from your agent. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoveTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleRemove}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
```

**Step 4: Run webapp lint + build**

Run: `cd webapp && pnpm lint && pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add webapp/src/app/\(app\)/skills/
git commit -m "feat: add skills management page"
```

---

## Task 4: Webapp — Add Skills to Sidebar

**Files:**
- Modify: `webapp/src/components/shared/app-sidebar.tsx`

**Step 1: Add Skills link to sidebar footer**

Import `Zap` icon from lucide-react and add a new `SidebarMenuItem` between Files and Settings:

```tsx
// Add to import:
import { ..., Zap } from "lucide-react";

// Add between Files and Settings SidebarMenuItems:
<SidebarMenuItem>
  <SidebarMenuButton
    onClick={() => router.push("/skills")}
    className="gap-2"
  >
    <Zap className="h-4 w-4" />
    Skills
  </SidebarMenuButton>
</SidebarMenuItem>
```

**Step 2: Run lint**

Run: `cd webapp && pnpm lint`
Expected: PASS

**Step 3: Commit**

```bash
git add webapp/src/components/shared/app-sidebar.tsx
git commit -m "feat: add Skills link to sidebar"
```

---

## Task 5: Pre-PR Checks & Final Commit

**Step 1: Run full check**

Run: `make check`
Expected: PASS (webapp build + webapp lint + gateway lint)

**Step 2: Verify the page renders**

Manual testing checklist:
- [ ] Navigate to `/skills` — page loads
- [ ] "Agent not running" message shows when machine is stopped
- [ ] When machine is running, installed skills are listed
- [ ] Toggle switch enables/disables skills
- [ ] Catalog shows all 13 curated skills
- [ ] "Install" button triggers installation
- [ ] "Custom Skill" button opens dialog
- [ ] Custom skill creation writes SKILL.md to machine
- [ ] Remove button shows confirmation then deletes

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any issues from pre-PR checks"
```

---

## Architecture Notes

### Why Fly Exec (not HTTP to OpenClaw gateway)?

OpenClaw's internal gateway uses **WebSocket JSON-RPC** (not REST HTTP). Our gateway communicates with user machines via two mechanisms:
1. **HTTP proxy** — for chat endpoints (`/v1/chat/completions`) where OpenClaw exposes REST
2. **Fly exec API** — for filesystem operations (used by `files.py`)

Skills management is primarily filesystem-based (reading dirs, writing files, editing JSON config), so **Fly exec is the natural fit**. The `clawhub` CLI is also invoked via exec.

### Why `npx clawhub` instead of pre-installing?

The `clawhub` npm package is ~2MB and infrequently used. Using `npx -y clawhub` avoids bloating the Docker image and auto-fetches the latest version. The first invocation will be slower (~5-10s) as npx downloads it, but subsequent calls use the npx cache.

### Catalog approach

The catalog is **hardcoded in the frontend** with the 12 curated skills. This avoids an extra exec call to the machine on page load. The `/skills/catalog` endpoint exists for future search functionality but isn't used in the initial UI to keep things fast.

### Skill paths

- **Workspace skills** (`/data/.openclaw/skills/`) — where ClawHub installs to and custom skills go. Highest priority.
- **Managed skills** (`/root/.openclaw/skills/`) — user-managed, persists across sessions.
- **Config** (`/root/.openclaw/openclaw.json`) — enable/disable state, API keys, env vars.
