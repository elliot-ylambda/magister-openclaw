"""Tests for authentication middleware."""

import hashlib
import time
from unittest.mock import MagicMock, patch

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
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


# ── JWT Auth (ES256) ──────────────────────────────────────────


@pytest.fixture
def ec_key_pair():
    """Generate a fresh EC key pair for ES256 tests."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()
    return private_key, public_key


def _make_es256_jwt(payload: dict, private_key, kid: str = "test-kid") -> str:
    """Create an ES256-signed JWT with a kid header."""
    return pyjwt.encode(
        payload, private_key, algorithm="ES256", headers={"kid": kid}
    )


@pytest.fixture
def es256_app(ec_key_pair):
    """FastAPI app with ES256 JWKS support via mocked PyJWKClient."""
    private_key, public_key = ec_key_pair

    mock_signing_key = MagicMock()
    mock_signing_key.key = public_key

    mock_jwks_client = MagicMock()
    mock_jwks_client.get_signing_key_from_jwt.return_value = mock_signing_key

    with patch("jwt.PyJWKClient", return_value=mock_jwks_client):
        app = FastAPI()
        verify_jwt = create_jwt_dependency(JWT_SECRET, supabase_url="https://fake.supabase.co")

        @app.get("/protected")
        async def protected(user_id: str = verify_jwt):
            return {"user_id": user_id}

    return TestClient(app), private_key


def test_jwt_es256_valid(es256_app):
    client, private_key = es256_app
    token = _make_es256_jwt(
        {"sub": "user-es256", "aud": "authenticated", "exp": int(time.time()) + 3600},
        private_key,
    )
    resp = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json() == {"user_id": "user-es256"}


def test_jwt_es256_no_jwks_client():
    """ES256 token should be rejected when no supabase_url is configured (no JWKS client)."""
    app = FastAPI()
    verify_jwt = create_jwt_dependency(JWT_SECRET)  # no supabase_url

    @app.get("/protected")
    async def protected(user_id: str = verify_jwt):
        return {"user_id": user_id}

    client = TestClient(app)

    private_key = ec.generate_private_key(ec.SECP256R1())
    token = _make_es256_jwt(
        {"sub": "user-1", "aud": "authenticated", "exp": int(time.time()) + 3600},
        private_key,
    )
    resp = client.get("/protected", headers={"Authorization": f"Bearer {token}"})
    # Falls through to HS256 path, which rejects it (wrong algorithm/key)
    assert resp.status_code == 401


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
