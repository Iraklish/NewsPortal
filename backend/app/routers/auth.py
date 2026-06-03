"""Authentication routes: login, current user, password change, user admin.

Login is the only public endpoint. Everything else requires a valid token;
user management additionally requires an admin.
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..auth_deps import get_current_user, require_admin
from ..config import settings
from ..database import get_db
from ..models import User
from ..schemas import (
    AdminResetPasswordRequest,
    ChangePasswordRequest,
    LoginRequest,
    TokenResponse,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..services.security import (
    create_access_token,
    get_auth_secret,
    hash_password,
    verify_password,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Simple in-memory login throttle ───────────────────────────────────────────
# Best-effort brute-force mitigation: after _MAX_FAILS failed attempts for a
# given (username, client-ip) key within the window, further attempts are
# rejected with 429 until the window elapses. Resets on success.
_MAX_FAILS = 5
_WINDOW_SECONDS = 15 * 60
_fail_log: dict[str, list[float]] = {}


def _throttle_key(username: str, request: Request) -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}|{(username or '').lower()}"


def _check_throttle(key: str) -> None:
    now = time.time()
    attempts = [t for t in _fail_log.get(key, []) if now - t < _WINDOW_SECONDS]
    _fail_log[key] = attempts
    if len(attempts) >= _MAX_FAILS:
        retry = int(_WINDOW_SECONDS - (now - attempts[0]))
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {max(retry, 1)} seconds.",
        )


def _record_fail(key: str) -> None:
    _fail_log.setdefault(key, []).append(time.time())


def _clear_fail(key: str) -> None:
    _fail_log.pop(key, None)


def _min_password(pw: str) -> None:
    if not pw or len(pw) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    key = _throttle_key(body.username, request)
    _check_throttle(key)

    user = db.query(User).filter(User.username == body.username.strip()).first()
    # Constant-ish work + generic error: don't reveal whether the username exists.
    ok = bool(user) and user.is_active and verify_password(body.password, user.password_hash)
    if not ok:
        _record_fail(key)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    _clear_fail(key)
    from ..models import _utcnow
    user.last_login_at = _utcnow()
    db.commit()

    secret = get_auth_secret(db)
    expires_min = max(5, int(settings.auth_token_expire_minutes))
    token = create_access_token(user.id, secret, expires_min)
    return TokenResponse(
        access_token=token,
        expires_in=expires_min * 60,
        user=UserOut.model_validate(user),
    )


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    _min_password(body.new_password)
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"changed": True}


# ── Admin: user management ────────────────────────────────────────────────────

@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return db.query(User).order_by(User.id.asc()).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(
    body: UserCreate,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    _min_password(body.password)
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(
        username=username,
        password_hash=hash_password(body.password),
        is_admin=bool(body.is_admin),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    body: UserUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if body.username is not None:
        new_name = body.username.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Username cannot be empty")
        clash = db.query(User).filter(User.username == new_name, User.id != target.id).first()
        if clash:
            raise HTTPException(status_code=409, detail="Username already exists")
        target.username = new_name
    if body.is_active is not None:
        if target.id == admin.id and not body.is_active:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        target.is_active = body.is_active
    if body.is_admin is not None:
        if target.id == admin.id and not body.is_admin:
            raise HTTPException(status_code=400, detail="You cannot remove your own admin rights")
        target.is_admin = body.is_admin
    db.commit()
    db.refresh(target)
    return target


@router.post("/users/{user_id}/reset-password", response_model=UserOut)
def reset_password(
    user_id: int,
    body: AdminResetPasswordRequest,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    _min_password(body.new_password)
    target.password_hash = hash_password(body.new_password)
    db.commit()
    db.refresh(target)
    return target


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(target)
    db.commit()
    return {"deleted": True, "id": user_id}
