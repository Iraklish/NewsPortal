"""Authentication primitives implemented with the Python standard library only.

No third-party crypto dependencies — avoids native build issues and keeps the
auth stack self-contained:

* Passwords  → PBKDF2-HMAC-SHA256, 200k iterations, 16-byte per-user random salt.
* Tokens     → compact HS256 JWT signed with HMAC-SHA256.
* JWT secret → read from the AUTH_SECRET env var, else generated once and stored
               in AppSettings so it survives restarts (changing it invalidates
               all issued tokens).

All comparisons use hmac.compare_digest for constant-time behavior.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time

logger = logging.getLogger(__name__)

_PBKDF2_ITERATIONS = 200_000
_PBKDF2_ALGO = "pbkdf2_sha256"
_AUTH_SECRET_KEY = "auth_jwt_secret"


# ── Password hashing ──────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    """Return an encoded PBKDF2 hash: ``pbkdf2_sha256$iters$salt_b64$hash_b64``."""
    if not password:
        raise ValueError("password must not be empty")
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return (
        f"{_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}$"
        f"{base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verification of a password against an encoded PBKDF2 hash."""
    if not password or not stored:
        return False
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != _PBKDF2_ALGO:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ── JWT (HS256) ───────────────────────────────────────────────────────────────

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def create_access_token(user_id: int, secret: str, expires_minutes: int) -> str:
    """Issue a signed HS256 JWT for the given user id."""
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": str(user_id), "iat": now, "exp": now + expires_minutes * 60}
    seg = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    sig = hmac.new(secret.encode("utf-8"), seg.encode("utf-8"), hashlib.sha256).digest()
    return f"{seg}.{_b64url(sig)}"


def decode_access_token(token: str, secret: str) -> dict | None:
    """Verify signature + expiry and return the payload, or None if invalid."""
    if not token or token.count(".") != 2:
        return None
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        seg = f"{header_b64}.{payload_b64}"
        expected = hmac.new(secret.encode("utf-8"), seg.encode("utf-8"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


# ── Secret management ─────────────────────────────────────────────────────────

def get_auth_secret(db) -> str:
    """Return the JWT signing secret (env override → DB → generate-and-persist)."""
    env = os.getenv("AUTH_SECRET", "").strip()
    if env:
        return env
    from ..models import AppSettings
    row = db.query(AppSettings).filter(AppSettings.key == _AUTH_SECRET_KEY).first()
    if row and row.value:
        return row.value
    secret = secrets.token_urlsafe(48)
    if row:
        row.value = secret
    else:
        db.add(AppSettings(key=_AUTH_SECRET_KEY, value=secret))
    db.commit()
    logger.info("Generated and stored a new JWT signing secret")
    return secret
