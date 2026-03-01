"""File browser endpoints: list, read, write, create, delete.

Executes commands on user Fly machines via the Machines exec API.
JWT auth only (user-facing).
"""

from __future__ import annotations

import base64
import logging
import posixpath
import shlex

import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.models import MachineStatus
from app.services.fly import FlyClient
from app.services.supabase_client import SupabaseService

logger = logging.getLogger("gateway.files")

ROOT_DIR = "/data/.openclaw/"
BLOCKED_DIRS = ["/data/.openclaw/credentials/"]
MAX_FILE_SIZE = 1_048_576  # 1 MB


# ── Models ─────────────────────────────────────────────────

class FileEntry(BaseModel):
    name: str
    path: str
    type: str  # "file" | "directory"
    size: int
    modified: str  # ISO 8601


class FileListResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class FileReadResponse(BaseModel):
    path: str
    content: str
    size: int


class FileWriteRequest(BaseModel):
    path: str
    content: str


class FileCreateRequest(BaseModel):
    path: str
    content: str = ""
    is_directory: bool = False


# ── Helpers ────────────────────────────────────────────────

def _validate_path(path: str) -> str:
    """Normalize and validate a file path is under ROOT_DIR and not blocked."""
    normalized = posixpath.normpath(path)
    # Ensure it's under root
    if not normalized.startswith(ROOT_DIR.rstrip("/")):
        raise HTTPException(status_code=400, detail="Path must be under /data/.openclaw/")
    # Block credentials directory
    for blocked in BLOCKED_DIRS:
        if normalized.startswith(blocked.rstrip("/")) or normalized + "/" == blocked:
            raise HTTPException(status_code=403, detail="Access to credentials directory is forbidden")
    return normalized


async def _exec_on_machine(
    fly: FlyClient, app: str, machine_id: str, cmd: list[str]
) -> dict:
    """Run exec and map common errors to HTTP codes."""
    result = await fly.exec_command(app, machine_id, cmd)
    stderr = result.get("stderr", "")
    exit_code = result.get("exit_code", 0)

    if exit_code != 0:
        if "No such file or directory" in stderr:
            raise HTTPException(status_code=404, detail="File or directory not found")
        if "Permission denied" in stderr:
            raise HTTPException(status_code=403, detail="Permission denied")
        if "Is a directory" in stderr:
            raise HTTPException(status_code=400, detail="Path is a directory, not a file")
        if "Not a directory" in stderr:
            raise HTTPException(status_code=400, detail="Path component is not a directory")
        raise HTTPException(status_code=500, detail=f"Command failed: {stderr.strip()}")

    return result


# ── Router factory ─────────────────────────────────────────

def create_files_router(
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
        """Extract user_id from JWT. No API key path — user-facing only."""
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
                detail="Machine must be running to browse files. Start your agent first.",
            )
        if not machine.fly_machine_id:
            raise HTTPException(status_code=409, detail="Machine has no Fly instance")
        return machine

    # ── Endpoints ──────────────────────────────────────────

    @router.get("/files/list")
    async def list_files(request: Request, path: str = ROOT_DIR):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        validated = _validate_path(path)

        # find -maxdepth 1 -mindepth 1 -printf "%y|%s|%T@|%f\n"
        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["find", validated, "-maxdepth", "1", "-mindepth", "1",
             "-printf", r"%y|%s|%T@|%f\n"],
        )

        entries: list[FileEntry] = []
        stdout = result.get("stdout", "")
        for line in stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("|", 3)
            if len(parts) != 4:
                continue
            ftype, size_str, mtime_str, name = parts
            entry_path = posixpath.join(validated, name)
            # Skip blocked dirs in listing
            skip = False
            for blocked in BLOCKED_DIRS:
                if entry_path.startswith(blocked.rstrip("/")) or entry_path + "/" == blocked:
                    skip = True
                    break
            if skip:
                continue
            try:
                from datetime import datetime, timezone
                mtime = datetime.fromtimestamp(float(mtime_str), tz=timezone.utc).isoformat()
            except (ValueError, OSError):
                mtime = ""
            entries.append(FileEntry(
                name=name,
                path=entry_path,
                type="directory" if ftype == "d" else "file",
                size=int(size_str) if size_str.isdigit() else 0,
                modified=mtime,
            ))

        # Sort: directories first, then alphabetical
        entries.sort(key=lambda e: (0 if e.type == "directory" else 1, e.name.lower()))
        return FileListResponse(path=validated, entries=entries)

    @router.get("/files/read")
    async def read_file(request: Request, path: str):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        validated = _validate_path(path)

        # Check size first
        stat_result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["stat", "-c", "%s", validated],
        )
        size = int(stat_result.get("stdout", "0").strip())
        if size > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({size} bytes). Maximum is {MAX_FILE_SIZE} bytes.",
            )

        # Read via base64 for safe transport
        result = await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["base64", "-w", "0", validated],
        )

        b64_data = result.get("stdout", "").strip()
        try:
            content = base64.b64decode(b64_data).decode("utf-8")
        except (UnicodeDecodeError, base64.binascii.Error):
            raise HTTPException(
                status_code=422, detail="File contains binary content and cannot be displayed"
            )

        return FileReadResponse(path=validated, content=content, size=size)

    @router.put("/files/write")
    async def write_file(request: Request, body: FileWriteRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        validated = _validate_path(body.path)

        # Encode content as base64 for safe shell transport
        b64_content = base64.b64encode(body.content.encode("utf-8")).decode("ascii")
        safe_path = shlex.quote(validated)

        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"echo {shlex.quote(b64_content)} | base64 -d > {safe_path}"],
        )

        logger.info(f"[files] User {user_id} wrote {validated}")
        return {"status": "ok", "path": validated}

    @router.post("/files/create")
    async def create_file(request: Request, body: FileCreateRequest):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        validated = _validate_path(body.path)
        safe_path = shlex.quote(validated)

        if body.is_directory:
            await _exec_on_machine(
                fly, machine.fly_app_name, machine.fly_machine_id,
                ["mkdir", "-p", validated],
            )
        elif body.content:
            b64_content = base64.b64encode(body.content.encode("utf-8")).decode("ascii")
            # Ensure parent directory exists
            parent = posixpath.dirname(validated)
            safe_parent = shlex.quote(parent)
            await _exec_on_machine(
                fly, machine.fly_app_name, machine.fly_machine_id,
                ["bash", "-c", f"mkdir -p {safe_parent} && echo {shlex.quote(b64_content)} | base64 -d > {safe_path}"],
            )
        else:
            parent = posixpath.dirname(validated)
            safe_parent = shlex.quote(parent)
            await _exec_on_machine(
                fly, machine.fly_app_name, machine.fly_machine_id,
                ["bash", "-c", f"mkdir -p {safe_parent} && touch {safe_path}"],
            )

        logger.info(f"[files] User {user_id} created {validated}")
        return {"status": "ok", "path": validated}

    @router.delete("/files/delete")
    async def delete_file(request: Request, path: str):
        user_id = await _resolve_user(request)
        machine = await _get_running_machine(user_id)
        validated = _validate_path(path)

        # Block deletion of the root directory itself
        if validated.rstrip("/") == ROOT_DIR.rstrip("/"):
            raise HTTPException(status_code=400, detail="Cannot delete root directory")

        safe_path = shlex.quote(validated)
        await _exec_on_machine(
            fly, machine.fly_app_name, machine.fly_machine_id,
            ["bash", "-c", f"rm -rf {safe_path}"],
        )

        logger.info(f"[files] User {user_id} deleted {validated}")
        return {"status": "ok", "path": validated}

    return router
