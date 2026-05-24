import asyncio
import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..config import DEFAULT_ASK_SYSTEM_PROMPT, DEFAULT_CHAT_SYSTEM_PROMPT, settings
from ..database import get_db
from ..models import AppSettings
from ..schemas import AppSettingsOut, KeyStatus, SettingsUpdate

router = APIRouter()
logger = logging.getLogger(__name__)

_SECRET_KEYS = [
    "anthropic_api_key",
    "openai_api_key",
    "gemini_api_key",
    "deepseek_api_key",
    "custom_ai_api_key",
    "fred_api_key",
    "alpha_vantage_api_key",
    "polygon_api_key",
    "google_search_api_key",
    "google_search_cx",
    "news_api_key",
]

_NON_SECRET_KEYS = [
    "default_ai_provider",
    "default_ai_model",
    "custom_ai_endpoint",
    "custom_ai_model",
    "auto_analyze_enabled",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _db_get(db: Session, key: str) -> str | None:
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    return row.value if row else None


def _effective_value(db: Session, key: str) -> str:
    """Read from DB first, fall back to config."""
    db_val = _db_get(db, key)
    if db_val:
        return db_val
    return getattr(settings, key, "") or ""


def _set_db(db: Session, key: str, value: str):
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if row:
        row.value = value
        row.updated_at = datetime.utcnow()
    else:
        row = AppSettings(key=key, value=value)
        db.add(row)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=AppSettingsOut)
def get_settings(db: Session = Depends(get_db)):
    key_statuses = {}
    for key in _SECRET_KEYS:
        val = _effective_value(db, key)
        key_statuses[key] = KeyStatus(has_key=bool(val), provider=key)

    default_provider = _effective_value(db, "default_ai_provider") or "anthropic"
    default_model = _effective_value(db, "default_ai_model") or "claude-sonnet-4-6"
    custom_endpoint = _effective_value(db, "custom_ai_endpoint") or None
    custom_model = _effective_value(db, "custom_ai_model") or None

    chat_override = _db_get(db, "chat_system_prompt") or ""
    ask_override = _db_get(db, "ask_system_prompt") or ""
    chat_effective = chat_override if chat_override.strip() else DEFAULT_CHAT_SYSTEM_PROMPT
    ask_effective = ask_override if ask_override.strip() else DEFAULT_ASK_SYSTEM_PROMPT

    auto_override = _db_get(db, "auto_analyze_enabled")
    if auto_override is not None:
        auto_analyze = auto_override.strip().lower() in ("1", "true", "yes", "on")
    else:
        auto_analyze = bool(settings.auto_analyze_enabled)

    return AppSettingsOut(
        **key_statuses,
        default_ai_provider=default_provider,
        default_ai_model=default_model,
        custom_ai_endpoint=custom_endpoint,
        custom_ai_model=custom_model,
        chat_system_prompt=chat_effective,
        ask_system_prompt=ask_effective,
        chat_system_prompt_default=DEFAULT_CHAT_SYSTEM_PROMPT,
        ask_system_prompt_default=DEFAULT_ASK_SYSTEM_PROMPT,
        chat_system_prompt_customized=bool(chat_override.strip()),
        ask_system_prompt_customized=bool(ask_override.strip()),
        auto_analyze_enabled=auto_analyze,
    )


@router.get("/models")
async def list_models(
    provider: str = Query(..., description="anthropic | openai | gemini | deepseek | custom"),
    db: Session = Depends(get_db),
):
    """Fetch available model IDs from the given provider's API."""
    provider = provider.strip().lower()

    if provider == "anthropic":
        api_key = _effective_value(db, "anthropic_api_key")
        if not api_key:
            raise HTTPException(status_code=400, detail="Anthropic API key not configured")
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(
                    "https://api.anthropic.com/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                )
                r.raise_for_status()
                data = r.json()
            return {"models": [m["id"] for m in data.get("data", [])]}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Anthropic API error: {exc}")

    if provider == "openai":
        api_key = _effective_value(db, "openai_api_key")
        if not api_key:
            raise HTTPException(status_code=400, detail="OpenAI API key not configured")
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                r.raise_for_status()
                data = r.json()
            ids = [m["id"] for m in data.get("data", [])]
            ids = [m for m in ids if any(m.startswith(p) for p in ("gpt-", "o1", "o3", "chatgpt-"))]
            return {"models": sorted(set(ids))}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"OpenAI API error: {exc}")

    if provider == "gemini":
        api_key = _effective_value(db, "gemini_api_key")
        if not api_key:
            raise HTTPException(status_code=400, detail="Gemini API key not configured")
        try:
            def _list():
                import google.generativeai as genai
                genai.configure(api_key=api_key)
                names = []
                for m in genai.list_models():
                    if "generateContent" in getattr(m, "supported_generation_methods", []):
                        nm = (m.name or "").replace("models/", "")
                        if nm:
                            names.append(nm)
                return sorted(set(names))
            models = await asyncio.get_event_loop().run_in_executor(None, _list)
            return {"models": models}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Gemini API error: {exc}")

    if provider == "deepseek":
        api_key = _effective_value(db, "deepseek_api_key")
        if not api_key:
            raise HTTPException(status_code=400, detail="DeepSeek API key not configured")
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(
                    "https://api.deepseek.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                r.raise_for_status()
                data = r.json()
            return {"models": [m["id"] for m in data.get("data", [])]}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"DeepSeek API error: {exc}")

    if provider == "custom":
        api_key = _effective_value(db, "custom_ai_api_key")
        endpoint = _effective_value(db, "custom_ai_endpoint")
        if not endpoint:
            raise HTTPException(status_code=400, detail="Custom endpoint not configured")
        url = endpoint.rstrip("/") + "/models"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
                r = await client.get(url, headers=headers)
                r.raise_for_status()
                data = r.json()
            ids = [m["id"] for m in data.get("data", [])] if isinstance(data, dict) else []
            return {"models": ids}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Custom endpoint error: {exc}")

    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


_RESETTABLE_KEYS = {
    "chat_system_prompt", "ask_system_prompt",
    "custom_ai_endpoint", "custom_ai_model",
}


@router.delete("/{key}")
def reset_setting(key: str, db: Session = Depends(get_db)):
    """Delete a stored setting override so the default takes over."""
    if key not in _SECRET_KEYS and key not in _RESETTABLE_KEYS and key not in _NON_SECRET_KEYS:
        raise HTTPException(status_code=400, detail=f"Cannot reset key '{key}'")
    row = db.query(AppSettings).filter(AppSettings.key == key).first()
    if not row:
        return {"reset": key, "existed": False}
    db.delete(row)
    db.commit()
    return {"reset": key, "existed": True}


@router.put("")
def update_settings(body: SettingsUpdate, db: Session = Depends(get_db)):
    updated_keys = []
    update_dict = body.model_dump(exclude_none=True)

    _no_strip = {"chat_system_prompt", "ask_system_prompt"}
    _bool_keys = {"auto_analyze_enabled"}

    for key, value in update_dict.items():
        if value is None:
            continue

        # Booleans always save (true → "1", false → "0")
        if key in _bool_keys:
            _set_db(db, key, "1" if bool(value) else "0")
            updated_keys.append(key)
            continue

        clean = str(value) if key in _no_strip else str(value).strip()
        if not clean and key not in _no_strip:
            continue
        if key in _no_strip and not clean.strip():
            # treat empty/whitespace prompt as a clear → delete row
            row = db.query(AppSettings).filter(AppSettings.key == key).first()
            if row:
                db.delete(row)
            updated_keys.append(key)
            continue
        _set_db(db, key, clean)
        updated_keys.append(key)

    if updated_keys:
        db.commit()

    return {"updated": updated_keys, "count": len(updated_keys)}
