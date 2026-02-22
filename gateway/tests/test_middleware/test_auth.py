"""Tests for authentication middleware."""

import hashlib
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware.auth import (
    create_api_key_dependency,
    create_jwt_dependency,
    hash_token,
    verify_machine_token,
)

JWT_SECRET = "test-jwt-secret-for-tests"
API_KEY = "test-gateway-api-key"


def _make_jwt(payload: dict, secret: str = JWT_SECRET) -> str:
    """Create a signed JWT for testing."""
    from jose import jwt as jose_jwt

    return jose_jwt.encode(payload, secret, algorithm="HS256")


# ── hash_token ────────────────────────────────────────────────


def test_hash_token():
    token = "my-secret-token"
    expected = hashlib.sha256(token.encode()).hexdigest()
    assert hash_token(token) == expected


def test_hash_token_deterministic():
    assert hash_token("abc") == hash_token("abc")


def test_hash_token_different_inputs():
    assert hash_token("a") != hash_token("b")


# ── JWT Auth ──────────────────────────────────────────────────


@pytest.fixture
def jwt_app():
    app = FastAPI()
    verify_jwt = create_jwt_dependency(JWT_SECRET)

    @app.get("/protected")
    async def protected(user_id: str = verify_jwt):
        return {"user_id": user_id}

    return TestClient(app)


def test_jwt_missing_header(jwt_app):
    resp = jwt_app.get("/protected")
    assert resp.status_code == 401


def test_jwt_invalid_token(jwt_app):
    resp = jwt_app.get("/protected", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401


def test_jwt_wrong_secret(jwt_app):
    token = _make_jwt({"sub": "user-1", "aud": "authenticated"}, secret="wrong-secret")
    resp = jwt_app.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_jwt_expired(jwt_app):
    token = _make_jwt(
        {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) - 60}
    )
    resp = jwt_app.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_jwt_missing_sub(jwt_app):
    token = _make_jwt({"aud": "authenticated", "exp": int(time.time()) + 3600})
    resp = jwt_app.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_jwt_valid(jwt_app):
    token = _make_jwt(
        {"sub": "user-123", "aud": "authenticated", "exp": int(time.time()) + 3600}
    )
    resp = jwt_app.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "user-123"}


# ── API Key Auth ──────────────────────────────────────────────


@pytest.fixture
def api_key_app():
    app = FastAPI()
    verify_api_key = create_api_key_dependency(API_KEY)

    @app.post("/admin", dependencies=[verify_api_key])
    async def admin():
        return {"ok": True}

    return TestClient(app)


def test_api_key_missing(api_key_app):
    resp = api_key_app.post("/admin")
    assert resp.status_code == 401


def test_api_key_wrong(api_key_app):
    resp = api_key_app.post("/admin", headers={"Authorization": "Bearer wrong-key"})
    assert resp.status_code == 401


def test_api_key_valid(api_key_app):
    resp = api_key_app.post(
        "/admin", headers={"Authorization": f"Bearer {API_KEY}"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
