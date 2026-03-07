# Bundled Catalog Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ClawHub-based skill install with locally bundled catalog skills that ship in the Docker image and install instantly via filesystem copy.

**Architecture:** Catalog skills live in `catalog-skills/` at the repo root. The Dockerfile COPYs them to `/app/catalog-skills/` (a staging path OpenClaw does not scan). The install endpoint copies from staging to the workspace skills dir. The webapp's hardcoded `CATALOG_SKILLS` array drives the UI. No ClawHub dependency, no network calls, no rate limits.

**Tech Stack:** Python/FastAPI (gateway), Next.js/React (webapp), Docker, Fly.io Machines exec API

---

### Task 1: Create `catalog-skills/` directory with initial skills

**Files:**
- Create: `catalog-skills/` directory with skill subdirectories

We need to seed this with the skills from the current `CATALOG_SKILLS` hardcoded list. For now, create placeholder SKILL.md files for each. These can be replaced with real content pulled from ClawHub later.

**Step 1: Create the catalog-skills directory with one real example**

```bash
mkdir -p catalog-skills/proactive-agent
mkdir -p catalog-skills/self-improving-agent
mkdir -p catalog-skills/tavily-search
mkdir -p catalog-skills/gog
mkdir -p catalog-skills/agent-browser
mkdir -p catalog-skills/brave-search
mkdir -p catalog-skills/skill-creator
mkdir -p catalog-skills/frontend-design
mkdir -p catalog-skills/slack
mkdir -p catalog-skills/automation-workflows
mkdir -p catalog-skills/nano-pdf
mkdir -p catalog-skills/nano-banana-pro
mkdir -p catalog-skills/elite-longterm-memory
```

For each, create a `SKILL.md` with proper frontmatter. The actual content should be pulled from ClawHub for each skill (use `clawhub` CLI or download from `https://clawhub.ai/api/v1/skills/<slug>`). Each skill is a directory that may contain:
- `SKILL.md` (required)
- `references/` (optional, extra docs)
- `scripts/` (optional, executable code)
- `evals/` (optional)

**Step 2: Verify structure**

```bash
find catalog-skills/ -type f | sort
```

Expected: At minimum one `SKILL.md` per skill directory.

**Step 3: Commit**

```bash
git add catalog-skills/
git commit -m "feat: add catalog-skills directory with bundled skills"
```

---

### Task 2: Update Dockerfile to bundle catalog skills

**Files:**
- Modify: `openclaw-image/Dockerfile`

**Step 1: Add COPY for catalog-skills and remove clawhub install**

In `openclaw-image/Dockerfile`, replace:

```dockerfile
# --- ClawHub CLI (for skill install/update from the registry) ---
RUN npm i -g clawhub
```

With:

```dockerfile
# --- Catalog Skills (staged, not active — users install from UI) ---
COPY catalog-skills/ /app/catalog-skills/
```

This stages skills at `/app/catalog-skills/` which OpenClaw does NOT scan (it only scans `$OPENCLAW_HOME/skills/` and `$OPENCLAW_HOME/workspace/skills/`).

**Step 2: Verify Dockerfile is valid**

```bash
# Quick syntax check — just ensure no parse errors
docker build --check -f openclaw-image/Dockerfile . 2>&1 || echo "Check flag not supported, visual inspection OK"
```

**Step 3: Commit**

```bash
git add openclaw-image/Dockerfile
git commit -m "feat: bundle catalog skills in image, remove clawhub dependency"
```

---

### Task 3: Rewrite install endpoint to copy from staging

**Files:**
- Modify: `gateway/app/routes/skills.py`

The install endpoint currently runs `clawhub install` on the machine. Replace it with a simple `cp -r` from the staging dir to the workspace dir.

**Step 1: Update constants and install endpoint**

Add new constant at the top of `skills.py`:

```python
CATALOG_SKILLS_DIR = "/app/catalog-skills/"
```

Replace the `install_skill` endpoint body with:

```python
@router.post("/skills/install")
async def install_skill(request: Request, body: SkillInstallRequest):
    user_id = await _resolve_user(request)
    machine = await _get_running_machine(user_id)

    # Skill name is the directory name in catalog-skills/
    # Strip author prefix if present (e.g. "halthelobster/proactive-agent" -> "proactive-agent")
    skill_name = body.slug.split("/")[-1] if "/" in body.slug else body.slug
    safe_name = shlex.quote(skill_name)

    logger.info(f"[skills] User {user_id} installing catalog skill {skill_name} on app={machine.fly_app_name}")

    # Copy from staging dir to workspace skills dir
    cmd = (
        f"test -d {CATALOG_SKILLS_DIR}{safe_name} && "
        f"mkdir -p {WORKSPACE_SKILLS_DIR} && "
        f"cp -r {CATALOG_SKILLS_DIR}{safe_name} {WORKSPACE_SKILLS_DIR}{safe_name}"
    )

    result = await _exec_on_machine(
        fly, machine.fly_app_name, machine.fly_machine_id,
        ["bash", "-c", cmd],
    )

    logger.info(f"[skills] User {user_id} installed catalog skill {skill_name}")
    return {"status": "ok", "slug": skill_name}
```

Key changes:
- `test -d` checks the skill exists in staging before copying (returns exit 1 → 404 via `_exec_on_machine`)
- No timeout increase needed — `cp -r` is instant
- No network calls, no rate limits

**Step 2: Remove all ClawHub dead code from skills.py**

- Delete the `search_catalog` endpoint entirely (lines ~349-368) — catalog is hardcoded in webapp
- Remove the ClawHub rate-limit detection from `_exec_on_machine` (the `"Rate limit"` check, line ~94-95) — no longer possible
- Remove any comments referencing ClawHub/clawhub

**Step 3: Verify no ClawHub references remain in gateway**

```bash
grep -rn "clawhub\|ClawHub" gateway/
```

Expected: zero matches.

**Step 4: Run gateway lint**

```bash
make gateway-lint
```

Expected: passes clean

**Step 5: Commit**

```bash
git add gateway/app/routes/skills.py
git commit -m "feat: install skills from bundled catalog, remove clawhub dependency"
```

---

### Task 4: Update webapp catalog to use skill directory names

**Files:**
- Modify: `webapp/src/app/(app)/skills/skills-client.tsx`
- Modify: `webapp/src/lib/gateway.ts`

**Step 1: Update CATALOG_SKILLS to use directory names as slugs**

In `skills-client.tsx`, change the `CATALOG_SKILLS` array so `slug` matches the directory name in `catalog-skills/` (no author prefix):

```typescript
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
  // ... same for all others, just remove the "author/" prefix from slug
];
```

**Step 2: Simplify `isInstalled` check**

Since slugs now match directory names directly, simplify:

```typescript
const isInstalled = useCallback(
  (slug: string) => {
    return skills.some(
      (s) => s.name.toLowerCase() === slug.toLowerCase()
    );
  },
  [skills]
);
```

**Step 3: Remove all ClawHub dead code from webapp**

In `webapp/src/lib/gateway.ts`, remove:
- The `CatalogSkill` type (lines ~405-409)
- The `searchCatalog` function (lines ~469-474)

In `webapp/src/app/(app)/skills/skills-client.tsx`:
- Change "Curated skills from ClawHub. Install with one click." to "Curated skills for your agent. Install with one click." (line ~395)

**Step 4: Verify no ClawHub references remain in webapp**

```bash
grep -rn "clawhub\|ClawHub" webapp/src/
```

Expected: zero matches.

**Step 4: Run webapp lint + build**

```bash
make webapp-lint && make webapp-build
```

Expected: passes clean

**Step 5: Commit**

```bash
git add webapp/src/app/(app)/skills/skills-client.tsx webapp/src/lib/gateway.ts
git commit -m "feat: update webapp catalog to use bundled skill directory names"
```

---

### Task 5: Run full pre-PR check

**Step 1: Run make check**

```bash
make check
```

Expected: webapp build + webapp lint + gateway lint all pass.

**Step 2: Commit any remaining fixes if needed**

---

### Task 6: Populate catalog skills with real content

This is a manual/semi-automated step. For each skill in `catalog-skills/`, we need to download the actual SKILL.md (and any references/scripts) from ClawHub.

**Option A: Manual download**

For each skill, fetch from the ClawHub API:

```bash
# Example for proactive-agent
curl -s "https://clawhub.ai/api/v1/skills/proactive-agent" | jq .
```

Then download the skill files and place them in the corresponding `catalog-skills/<name>/` directory.

**Option B: One-time clawhub install locally**

```bash
cd /tmp/clawhub-fetch
for slug in proactive-agent self-improving-agent tavily-search gog agent-browser brave-search skill-creator frontend-design slack automation-workflows nano-pdf nano-banana-pro elite-longterm-memory; do
  clawhub install $slug --workdir /tmp/clawhub-fetch --dir skills --no-input
done
# Then copy from /tmp/clawhub-fetch/skills/ to catalog-skills/
cp -r /tmp/clawhub-fetch/skills/* /path/to/magister-marketing/catalog-skills/
```

**Step 2: Commit the real skill content**

```bash
git add catalog-skills/
git commit -m "feat: populate catalog skills with real ClawHub content"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `catalog-skills/` (new) | Bundled skill directories (SKILL.md + references + scripts) |
| `openclaw-image/Dockerfile` | COPY catalog-skills to `/app/catalog-skills/`, remove `npm i -g clawhub` |
| `gateway/app/routes/skills.py` | Install = `cp -r` from staging, remove catalog search endpoint |
| `webapp/src/app/(app)/skills/skills-client.tsx` | Slugs = dir names (no author prefix), simplify `isInstalled` |
| `webapp/src/lib/gateway.ts` | Remove `searchCatalog` + `CatalogSkill` type |

## What stays the same

- List skills endpoint (reads from machine filesystem — unchanged)
- Toggle endpoint (reads/writes openclaw.json — unchanged)
- Remove endpoint (rm -rf from workspace/managed dirs — unchanged)
- Custom skill creation (writes SKILL.md to workspace — unchanged)
- Webapp UI layout and components (unchanged)
