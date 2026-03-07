# Skills Management Feature — Progress

## End Goal

A fully working Skills management page in the webapp where users can:
- **View** all installed skills (managed + workspace) with descriptions, emoji, enabled state
- **Enable/disable** skills via toggle (writes to `openclaw.json` config)
- **Install** skills from the ClawHub registry catalog
- **Remove** skills from the agent
- **Create** custom skills with a SKILL.md editor

## Architecture & Approach

Skills are entirely **filesystem + config-file based** on the user's Fly machine. No database involved.

### How OpenClaw discovers skills (precedence low→high):
1. **Bundled** — shipped with OpenClaw npm package
2. **Managed** — `$OPENCLAW_HOME/skills/` (our entrypoint copies marketing skills here on every boot)
3. **Workspace** — `$OPENCLAW_HOME/workspace/skills/` (user installs via clawhub go here, highest precedence)

### How enabled/disabled works:
- `$OPENCLAW_HOME/openclaw.json` → `skills.entries.<name>.enabled: false` disables a skill
- Default is enabled (no entry = enabled)
- OpenClaw's file watcher picks up changes automatically, no restart needed

### Gateway approach:
- All operations execute commands on the user's Fly machine via the **Fly Machines exec API**
- Gateway acts as a thin proxy: REST endpoints → shell commands on the machine
- JWT auth only (user-facing)

### Key paths on Docker machines (`OPENCLAW_HOME=/data/.openclaw`):
| What | Path |
|------|------|
| Config | `/data/.openclaw/openclaw.json` |
| Managed skills | `/data/.openclaw/skills/` |
| Workspace skills | `/data/.openclaw/workspace/skills/` |

## Branch

`ee/feature/skills-management` — 2 commits on branch, plus staged work from other features (email, feedback, etc.)

## Files Changed

- `gateway/app/routes/skills.py` — All skill endpoints (list, install, remove, toggle, custom, catalog)
- `gateway/app/models.py` — Pydantic models (SkillEntry, SkillListResponse, etc.)
- `gateway/app/main.py` — Router registration
- `gateway/app/services/fly.py` — Fixed exec_command httpx timeout
- `openclaw-image/Dockerfile` — Added `npm i -g clawhub`
- `webapp/src/app/(app)/skills/skills-client.tsx` — Full skills management UI
- `webapp/src/app/(app)/skills/page.tsx` + `loading.tsx` — Next.js page
- `webapp/src/lib/gateway.ts` — Client functions for skills API
- `webapp/src/components/ui/switch.tsx` — New Switch component
- `webapp/src/components/shared/app-sidebar.tsx` — Skills link in sidebar

## Completed Fixes

### 1. Rate limit on list skills (429 from Fly API)
- **Problem:** Original code made N+2 exec calls per directory (1 `ls` + 1 `head` per skill) → hit Fly rate limits
- **Fix:** Replaced with single `node -e` exec call that reads config + all SKILL.md headers, returns JSON

### 2. Wrong paths (config + skill directories)
- **Problem:** `CONFIG_PATH` was `/root/.openclaw/openclaw.json` (wrong), `MANAGED_SKILLS_DIR` was `/root/.openclaw/skills/` (doesn't exist)
- **Fix:** Corrected to `/data/.openclaw/openclaw.json`, `/data/.openclaw/skills/` (managed), `/data/.openclaw/workspace/skills/` (workspace)

### 3. Skill deduplication
- **Problem:** If a skill exists in both managed and workspace dirs, it appeared twice in results
- **Fix:** Node script uses a `Map` keyed by name — scans managed first, workspace overwrites, matching OpenClaw's own merge logic

### 4. python3 not available on Docker image
- **Problem:** List skills script used `python3 -c` but `node:22-bookworm` doesn't include python3
- **Fix:** Rewrote inline script from Python to Node.js

### 5. httpx client timeout < Fly exec timeout
- **Problem:** httpx client had 30s timeout, but exec commands request up to 60s from Fly API → httpx kills connection before command finishes
- **Fix:** Added optional `timeout` param to `fly._request()`, `exec_command()` now sets httpx timeout to `exec_timeout + 10s`

### 6. clawhub not installed on machines
- **Problem:** Install endpoint used `npx -y clawhub install` which has cold-start latency downloading the package
- **Fix:** Added `npm i -g clawhub` to Dockerfile, simplified install command to `clawhub install <slug> --no-input`

### 7. Install goes to wrong directory
- **Problem:** `clawhub install` cwd was `/data/.openclaw` → skills went to managed dir (gets overwritten on boot)
- **Fix:** Changed cwd to `/data/.openclaw/workspace` → skills go to workspace dir (survives boot, highest precedence)

### 8. Remove only checked one directory
- **Problem:** Remove only deleted from managed dir
- **Fix:** Now removes from both workspace and managed dirs

### 9. Custom skills created in wrong directory
- **Problem:** Custom skills were created in managed dir
- **Fix:** Now creates in workspace dir

## Current Failure

### `POST /api/skills/install` → 500 Internal Server Error

**Status:** Still failing after deploying gateway fixes. The 500 persists.

**Possible causes (not yet investigated):**
1. **Dockerfile not yet deployed** — `clawhub` won't be installed on existing machines until `make deploy-image` + `make deploy-machines` runs. If only `make deploy-gateway` was run, the machine still doesn't have `clawhub` globally installed, so `clawhub install` fails with "command not found"
2. **The Fly exec API itself** may be returning an error we're not seeing — need to add better error logging to capture stdout/stderr from the failed command
3. **ClawHub slug format** — docs show `clawhub install my-skill` but our catalog sends `halthelobster/proactive-agent` (with `/`). Need to verify clawhub accepts this format
4. **Network from Fly machine** — the machine may not have outbound HTTPS access to clawhub.ai

**Next steps:**
1. Verify the Dockerfile change was deployed (`make deploy-image` + `make deploy-machines`)
2. Add better error logging to the install endpoint (capture and return stderr)
3. SSH into a machine and test `clawhub install halthelobster/proactive-agent` manually
4. If clawhub doesn't accept slug format, may need to strip the `user/` prefix
