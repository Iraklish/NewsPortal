"""FastAPI auth dependencies — validate the Bearer token and load the user.

`get_current_user` is attached to every protected router; `require_admin`
guards admin-only endpoints (user management).
"""
from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .database import get_db
from .models import User
from .services.security import decode_access_token, get_auth_secret

logger = logging.getLogger(__name__)

# auto_error=False so we can return a consistent 401 with a WWW-Authenticate header.
_bearer = HTTPBearer(auto_error=False)

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or not creds.credentials:
        raise _UNAUTHENTICATED
    secret = get_auth_secret(db)
    payload = decode_access_token(creds.credentials, secret)
    if not payload:
        raise _UNAUTHENTICATED
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        raise _UNAUTHENTICATED
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or not user.is_active:
        raise _UNAUTHENTICATED
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges required")
    return user
