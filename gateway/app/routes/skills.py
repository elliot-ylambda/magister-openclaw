"""Skills management endpoints: list, install, remove, toggle, custom, catalog.

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

SKILLS_DIR = "/data/.openclaw/skills/"
MANAGED_SKILLS_DIR = "/root/.openclaw/skills/"
CONFIG_PATH = "/root/.openclaw/openclaw.json"

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
    result = await fly.exec_command(app, machine_id, cmd, timeout=timeout)
    stderr = result.get("stderr", "")
    exit_code = result.get("exit_code", 0)

    if exit_code != 0:
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

        # Read openclaw.json config for enabled/disabled state
        config: dict = {}
        try:
            cfg_result = await _exec_on_machine(
                fly, app_name, machine_id,
                ["cat", CONFIG_PATH],
            )
            config = json.loads(cfg_result.get("stdout", "{}"))
        except (HTTPException, json.JSONDecodeError):
            pass

        skill_entries = config.get("skills", {}).get("entries", {})

        skills: list[SkillEntry] = []

        # Scan both skill directories
        for skills_dir, source in [
            (SKILLS_DIR, "workspace"),
            (MANAGED_SKILLS_DIR, "managed"),
        ]:
            try:
                ls_result = await _exec_on_machine(
                    fly, app_name, machine_id,
                    ["bash", "-c", f"ls -1 {shlex.quote(skills_dir)} 2>/dev/null || true"],
                )
            except HTTPException:
                continue

            stdout = ls_result.get("stdout", "").strip()
            if not stdout:
                continue

            for name in stdout.split("\n"):
                name = name.strip()
                if not name:
                    continue

                # Read SKILL.md for metadata
                skill_md_path = f"{skills_dir}{name}/SKILL.md"
                description = ""
                emoji = ""
                homepage = ""
                try:
                    md_result = await _exec_on_machine(
                        fly, app_name, machine_id,
                        ["head", "-30", skill_md_path],
                    )
                    md_content = md_result.get("stdout", "")
                    description = _extract_description(md_content)
                    emoji = _extract_field(md_content, "emoji")
                    homepage = _extract_field(md_content, "homepage")
                except HTTPException:
                    pass

                # Check config for enabled state
                cfg = skill_entries.get(name, {})
                enabled = cfg.get("enabled", True)

                skills.append(SkillEntry(
                    name=name,
                    description=description,
                    enabled=enabled,
                    source=source,
                    emoji=emoji,
                    homepage=homepage,
                ))

        return SkillListResponse(skills=skills)

    @router.post("/skills/install")
    async def install_skill(request: Request, body: SkillInstallRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"cd /data/.openclaw && npx -y clawhub install {shlex.quote(body.slug)} --yes"],
            timeout=60,
        )

        logger.info(f"[skills] User {user_id} installed skill {body.slug}")
        return {
            "status": "ok",
            "slug": body.slug,
            "stdout": result.get("stdout", ""),
        }

    @router.delete("/skills/{skill_name}")
    async def remove_skill(request: Request, skill_name: str):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        safe_name = shlex.quote(skill_name)

        # Remove from user skills directory
        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"rm -rf {SKILLS_DIR}{safe_name}"],
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
        return {"status": "ok", "skill": body.name}

    @router.get("/skills/catalog")
    async def search_catalog(request: Request, query: str = ""):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)

        search_cmd = "npx -y clawhub search"
        if query:
            search_cmd += f" {shlex.quote(query)}"

        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", search_cmd],
            timeout=30,
        )

        return {
            "status": "ok",
            "query": query,
            "stdout": result.get("stdout", ""),
        }

    return router
