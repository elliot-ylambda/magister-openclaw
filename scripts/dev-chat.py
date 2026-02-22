#!/usr/bin/env python3
"""Dev helper: chat with the gateway from the command line.

Usage:
    python3 scripts/dev-chat.py "Hello"                     # new conversation
    python3 scripts/dev-chat.py "Follow up" --session <id>  # continue
    python3 scripts/dev-chat.py "Hello" --stream             # SSE streaming
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request


SUPABASE_URL = "http://127.0.0.1:54321"
GATEWAY_URL = "http://localhost:8080"
DEV_EMAIL = "dev@magister.local"
DEV_PASSWORD = "dev-password-not-for-production"


def get_env_value(key: str) -> str:
    with open("webapp/.env.local") as f:
        for line in f:
            if line.startswith(key + "="):
                return line.strip().split("=", 1)[1]
    raise SystemExit(f"Missing {key} in webapp/.env.local")


def get_jwt() -> str:
    anon_key = get_env_value("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    body = json.dumps({"email": DEV_EMAIL, "password": DEV_PASSWORD}).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        data=body,
        headers={"apikey": anon_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["access_token"]


def chat_blocking(jwt: str, message: str, session_id: str | None) -> None:
    payload: dict = {"message": message, "stream": False}
    if session_id:
        payload["session_id"] = session_id

    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/chat",
        data=body,
        headers={
            "Authorization": f"Bearer {jwt}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())

    print(data["response"])
    print(f"\n[session: {data['session_id']}]")


def chat_streaming(jwt: str, message: str, session_id: str | None) -> None:
    payload: dict = {"message": message, "stream": True}
    if session_id:
        payload["session_id"] = session_id

    # Use curl for streaming — urllib doesn't support SSE well
    cmd = [
        "curl", "-sN", "-X", "POST", f"{GATEWAY_URL}/api/chat",
        "-H", f"Authorization: Bearer {jwt}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps(payload),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    for line in proc.stdout:
        line = line.strip()
        if line.startswith("data: "):
            value = line[6:]
            if value:
                sys.stdout.write(value)
                sys.stdout.flush()
        elif line.startswith("event: session"):
            # Next data line is the session_id — will be captured below
            pass
        elif line.startswith("event: done"):
            break
    proc.wait()
    print()  # Final newline


def main() -> None:
    parser = argparse.ArgumentParser(description="Chat with the dev gateway")
    parser.add_argument("message", help="Message to send")
    parser.add_argument("--session", "-s", default="", help="Session ID to continue")
    parser.add_argument("--stream", action="store_true", help="Use SSE streaming")
    args = parser.parse_args()

    session_id = args.session if args.session else None
    jwt = get_jwt()

    if args.stream:
        chat_streaming(jwt, args.message, session_id)
    else:
        chat_blocking(jwt, args.message, session_id)


if __name__ == "__main__":
    main()
