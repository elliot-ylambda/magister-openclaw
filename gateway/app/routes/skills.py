"""Skills management endpoints: list, install, remove, toggle, custom.

Executes commands on user Fly machines via the Machines exec API.
JWT auth only (user-facing).
"""

from __future__ import annotations

import base64
import json
import logging
import re
import shlex

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request

from app.models import (
    MachineStatus,
    SkillEntry,
    SkillInstallRequest,
    SkillListResponse,
    SkillToggleRequest,
    CustomSkillRequest,
)
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.skills")

OPENCLAW_HOME = "/data/.openclaw"
CONFIG_PATH = f"{OPENCLAW_HOME}/openclaw.json"
MANAGED_SKILLS_DIR = f"{OPENCLAW_HOME}/skills/"
WORKSPACE_SKILLS_DIR = f"{OPENCLAW_HOME}/workspace/skills/"
CATALOG_SKILLS_DIR = "/app/catalog-skills/"

SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")


# ── Helpers ────────────────────────────────────────────────

def _extract_field(text: str, field: str) -> str:
    """Extract a YAML frontmatter field value from SKILL.md content."""
    if not text.startswith("---"):
        return ""
    parts = text.split("---", 2)
    if len(parts) < 3:
        return ""
    for line in parts[1].splitlines():
        stripped = line.strip()
        if stripped.startswith(f"{field}:"):
            return stripped[len(field) + 1:].strip().strip('"').strip("'")
    return ""


def _extract_description(text: str) -> str:
    """Extract description from SKILL.md YAML frontmatter."""
    desc = _extract_field(text, "description")
    if desc:
        return desc[:200]
    # No frontmatter — use first non-empty, non-heading line
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("---"):
            return line[:200]
    return ""


async def _exec_on_machine(
    fly: FlyClient, app: str, machine_id: str, cmd: list[str],
    *, timeout: int = 30,
) -> dict:
    """Run exec and map common errors to HTTP codes."""
    try:
        result = await fly.exec_command(app, machine_id, cmd, timeout=timeout)
    except Exception as exc:
        logger.error(f"[skills] Fly exec failed for app={app} machine={machine_id}: {exc}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to execute command on machine: {exc}",
        )

    stdout = result.get("stdout", "")
    stderr = result.get("stderr", "")
    exit_code = result.get("exit_code", 0)

    logger.debug(f"[skills] exec exit_code={exit_code} stdout={stdout[:200]} stderr={stderr[:200]}")

    if exit_code != 0:
        logger.warning(f"[skills] Command failed on app={app}: exit_code={exit_code} stderr={stderr[:500]}")
        if "No such file or directory" in stderr:
            raise HTTPException(status_code=404, detail="File or directory not found")
        if "Permission denied" in stderr:
            raise HTTPException(status_code=403, detail="Permission denied")
        raise HTTPException(status_code=500, detail=f"Command failed: {stderr.strip()}")

    return result


# ── Router factory ─────────────────────────────────────────

def create_skills_router(
    fly: FlyClient,
    supabase: SupabaseService,
    *,
    jwt_secret: str,
    api_key: str,
    supabase_url: str = "",
) -> APIRouter:
    router = APIRouter()

    # Set up JWKS client for ES256 verification
    jwks_client = None
    if supabase_url:
        from jwt import PyJWKClient
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)

    async def _resolve_user(request: Request) -> str:
        """Extract user_id from JWT. No API key path -- user-facing only."""
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing bearer token")
        token = auth[7:]

        try:
            header = pyjwt.get_unverified_header(token)
            alg = header.get("alg", "HS256")

            if alg == "ES256" and jwks_client:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = pyjwt.decode(
                    token, signing_key.key,
                    algorithms=["ES256"], audience="authenticated",
                )
            else:
                payload = pyjwt.decode(
                    token, jwt_secret,
                    algorithms=["HS256"], audience="authenticated",
                )
        except pyjwt.exceptions.PyJWTError as exc:
            raise HTTPException(status_code=401, detail=f"Invalid JWT: {exc}")

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="JWT missing sub claim")
        return user_id

    async def _get_running_machine(user_id: str):
        """Look up user's machine, require it to be running."""
        machine = await supabase.get_user_machine(user_id)
        if not machine:
            raise HTTPException(status_code=404, detail="No machine found")
        if machine.status != MachineStatus.running:
            raise HTTPException(
                status_code=409,
                detail="Machine must be running to manage skills. Start your agent first.",
            )
        if not machine.fly_machine_id:
            raise HTTPException(status_code=409, detail="Machine has no Fly instance")
        return machine

    # ── Endpoints ──────────────────────────────────────────

    @router.get("/skills")
    async def list_skills(request: Request):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        app_name = machine.fly_app_name
        machine_id = machine.fly_machine_id

        # Single exec call: read config + all SKILL.md headers as JSON
        # Uses node (not python3) since the image is node:22-bookworm
        script = r"""
const fs = require('fs');
const path = require('path');

let config = {};
try { config = JSON.parse(fs.readFileSync('""" + CONFIG_PATH + r"""', 'utf8')); } catch {}

const entries = (config.skills || {}).entries || {};
const seen = new Map();

const dirs = [
  ['""" + MANAGED_SKILLS_DIR + r"""', 'managed'],
  ['""" + WORKSPACE_SKILLS_DIR + r"""', 'workspace'],
];

for (const [skillsDir, source] of dirs) {
  let names;
  try { names = fs.readdirSync(skillsDir).sort(); } catch { continue; }
  for (const name of names) {
    const skillPath = path.join(skillsDir, name, 'SKILL.md');
    let header = '';
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      header = content.split('\n').slice(0, 30).join('\n');
    } catch {}
    const cfg = entries[name] || {};
    seen.set(name, { name, header, source, enabled: cfg.enabled !== false });
  }
}

console.log(JSON.stringify([...seen.values()]));
"""
        result = await _exec_on_machine(
            fly, app_name, machine_id,
            ["node", "-e", script],
        )

        skills: list[SkillEntry] = []
        try:
            raw_skills = json.loads(result.get("stdout", "[]"))
        except json.JSONDecodeError:
            raw_skills = []

        for entry in raw_skills:
            header = entry.get("header", "")
            skills.append(SkillEntry(
                name=entry["name"],
                description=_extract_description(header),
                enabled=entry.get("enabled", True),
                source=entry.get("source", ""),
                emoji=_extract_field(header, "emoji"),
                homepage=_extract_field(header, "homepage"),
            ))

        return SkillListResponse(skills=skills)

    @router.post("/skills/install")
    async def install_skill(request: Request, body: SkillInstallRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        # Skill name is the directory name in catalog-skills/
        skill_name = body.slug.split("/")[-1] if "/" in body.slug else body.slug
        safe_name = shlex.quote(skill_name)

        logger.info(f"[skills] User {user_id} installing catalog skill {skill_name} on app={machine.fly_app_name}")

        # Copy from bundled staging dir to workspace skills dir
        cmd = (
            f"test -d {CATALOG_SKILLS_DIR}{safe_name} && "
            f"mkdir -p {WORKSPACE_SKILLS_DIR} && "
            f"cp -r {CATALOG_SKILLS_DIR}{safe_name} {WORKSPACE_SKILLS_DIR}{safe_name}"
        )

        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", cmd],
        )

        logger.info(f"[skills] User {user_id} installed catalog skill {skill_name}")
        return {"status": "ok", "slug": skill_name}

    @router.delete("/skills/{skill_name}")
    async def remove_skill(request: Request, skill_name: str):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        safe_name = shlex.quote(skill_name)

        # Remove from both workspace and managed skill directories
        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"rm -rf {WORKSPACE_SKILLS_DIR}{safe_name} {MANAGED_SKILLS_DIR}{safe_name}"],
        )

        logger.info(f"[skills] User {user_id} removed skill {skill_name}")
        return {"status": "ok", "skill": skill_name}

    @router.patch("/skills/{skill_name}")
    async def toggle_skill(request: Request, skill_name: str, body: SkillToggleRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        app_name = machine.fly_app_name
        machine_id = machine.fly_machine_id

        # Read current config
        config: dict = {}
        try:
            cfg_result = await _exec_on_machine(
                fly, app_name, machine_id,
                ["cat", CONFIG_PATH],
            )
            config = json.loads(cfg_result.get("stdout", "{}"))
        except (HTTPException, json.JSONDecodeError):
            pass

        # Update using OpenClaw's skills.entries.<key>.enabled structure
        if "skills" not in config:
            config["skills"] = {}
        if "entries" not in config["skills"]:
            config["skills"]["entries"] = {}
        if skill_name not in config["skills"]["entries"]:
            config["skills"]["entries"][skill_name] = {}
        config["skills"]["entries"][skill_name]["enabled"] = body.enabled

        # Write updated config (base64 for safe transport)
        config_json = json.dumps(config, indent=2)
        b64 = base64.b64encode(config_json.encode()).decode()
        await _exec_on_machine(
            fly, app_name, machine_id,
            ["bash", "-c", f"echo {shlex.quote(b64)} | base64 -d > {shlex.quote(CONFIG_PATH)}"],
        )

        logger.info(f"[skills] User {user_id} toggled skill {skill_name} enabled={body.enabled}")
        return {"status": "ok", "skill": skill_name, "enabled": body.enabled}

    @router.post("/skills/custom")
    async def create_custom_skill(request: Request, body: CustomSkillRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        # Validate name
        if len(body.name) < 2 or len(body.name) > 64:
            raise HTTPException(
                status_code=400,
                detail="Skill name must be between 2 and 64 characters",
            )
        if not SKILL_NAME_RE.match(body.name):
            raise HTTPException(
                status_code=400,
                detail="Skill name must contain only lowercase letters, numbers, and hyphens",
            )

        skill_dir = f"{WORKSPACE_SKILLS_DIR}{body.name}"
        skill_md = f"{skill_dir}/SKILL.md"
        safe_dir = shlex.quote(skill_dir)
        safe_md = shlex.quote(skill_md)

        b64_content = base64.b64encode(body.content.encode("utf-8")).decode("ascii")

        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"mkdir -p {safe_dir} && echo {shlex.quote(b64_content)} | base64 -d > {safe_md}"],
        )

        logger.info(f"[skills] User {user_id} created custom skill {body.name}")
        return {"status": "ok", "skill": body.name}

    return router
