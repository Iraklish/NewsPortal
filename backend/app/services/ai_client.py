import asyncio
import logging
from dataclasses import dataclass, field
from typing import List, Optional

from ..config import settings

logger = logging.getLogger(__name__)


@dataclass
class GroundingCitation:
    title: Optional[str] = None
    url: Optional[str] = None
    snippet: Optional[str] = None


@dataclass
class GroundedResponse:
    text: str
    citations: List[GroundingCitation] = field(default_factory=list)
    provider_used_grounding: bool = False  # False if provider can't ground; text is still valid

# ── Helpers ───────────────────────────────────────────────────────────────────

async def get_current_ai_settings(db=None) -> tuple[str, str]:
    """Return (provider, model) reading from AppSettings table first, then config."""
    provider = settings.default_ai_provider
    model = settings.default_ai_model

    if db is not None:
        try:
            from ..models import AppSettings
            p_row = db.query(AppSettings).filter(AppSettings.key == "default_ai_provider").first()
            m_row = db.query(AppSettings).filter(AppSettings.key == "default_ai_model").first()
            if p_row and p_row.value:
                provider = p_row.value
            if m_row and m_row.value:
                model = m_row.value
        except Exception as exc:
            logger.warning("Could not read AI settings from DB: %s", exc)

    return provider, model


def _get_api_key(key_name: str, db=None) -> str:
    """Read an API key from AppSettings or fall back to config."""
    if db is not None:
        try:
            from ..models import AppSettings
            row = db.query(AppSettings).filter(AppSettings.key == key_name).first()
            if row and row.value:
                return row.value
        except Exception:
            pass
    return getattr(settings, key_name, "")


# ── Provider implementations ──────────────────────────────────────────────────

def _call_anthropic(api_key: str, model: str, system: str, user: str, max_tokens: int) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return response.content[0].text


def _call_openai(api_key: str, model: str, system: str, user: str, max_tokens: int,
                 base_url: str = None) -> str:
    import openai
    kwargs = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    client = openai.OpenAI(**kwargs)
    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return response.choices[0].message.content


def _call_gemini(api_key: str, model: str, system: str, user: str, max_tokens: int) -> str:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=user,
        config=types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
        ),
    )
    return response.text


# ── Public API ────────────────────────────────────────────────────────────────

async def call_ai(
    system: str,
    user: str,
    provider: str = None,
    model: str = None,
    max_tokens: int = 2048,
    db=None,
) -> str:
    """Call the configured AI provider and return the response text."""
    resolved_provider, resolved_model = await get_current_ai_settings(db)

    if provider:
        resolved_provider = provider
    if model:
        resolved_model = model

    loop = asyncio.get_event_loop()

    try:
        if resolved_provider == "anthropic":
            api_key = _get_api_key("anthropic_api_key", db)
            if not api_key:
                raise ValueError("Anthropic API key not configured")
            result = await loop.run_in_executor(
                None,
                lambda: _call_anthropic(api_key, resolved_model, system, user, max_tokens),
            )

        elif resolved_provider == "openai":
            api_key = _get_api_key("openai_api_key", db)
            if not api_key:
                raise ValueError("OpenAI API key not configured")
            result = await loop.run_in_executor(
                None,
                lambda: _call_openai(api_key, resolved_model, system, user, max_tokens),
            )

        elif resolved_provider == "gemini":
            api_key = _get_api_key("gemini_api_key", db)
            if not api_key:
                raise ValueError("Gemini API key not configured")
            result = await loop.run_in_executor(
                None,
                lambda: _call_gemini(api_key, resolved_model, system, user, max_tokens),
            )

        elif resolved_provider == "deepseek":
            api_key = _get_api_key("deepseek_api_key", db)
            if not api_key:
                raise ValueError("DeepSeek API key not configured")
            result = await loop.run_in_executor(
                None,
                lambda: _call_openai(
                    api_key,
                    resolved_model,
                    system,
                    user,
                    max_tokens,
                    base_url="https://api.deepseek.com/v1",
                ),
            )

        elif resolved_provider == "custom":
            api_key = _get_api_key("custom_ai_api_key", db)
            endpoint = _get_api_key("custom_ai_endpoint", db) or settings.custom_ai_endpoint
            custom_model = _get_api_key("custom_ai_model", db) or settings.custom_ai_model or resolved_model
            if not endpoint:
                raise ValueError("Custom AI endpoint not configured")
            result = await loop.run_in_executor(
                None,
                lambda: _call_openai(
                    api_key,
                    custom_model,
                    system,
                    user,
                    max_tokens,
                    base_url=endpoint,
                ),
            )

        else:
            raise ValueError(f"Unknown AI provider: {resolved_provider}")

        return result

    except Exception as exc:
        logger.error("AI call failed (provider=%s model=%s): %s", resolved_provider, resolved_model, exc)
        raise


# ── Grounded (web-search) calls ──────────────────────────────────────────────

def _call_gemini_grounded(api_key: str, model: str, system: str, user: str, max_tokens: int) -> GroundedResponse:
    """Gemini with built-in Google Search grounding."""
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)

    # Try the modern typed tool first, then fall back to legacy dict specs.
    last_exc = None
    response = None
    for attempt in range(3):
        try:
            if attempt == 0:
                tool = types.Tool(google_search=types.GoogleSearch())
            elif attempt == 1:
                tool = {"google_search": {}}
            else:
                tool = {"google_search_retrieval": {}}
            response = client.models.generate_content(
                model=model,
                contents=user,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    max_output_tokens=max_tokens,
                    tools=[tool],
                ),
            )
            break
        except Exception as exc:
            last_exc = exc
            response = None
    if response is None:
        raise last_exc or RuntimeError("Gemini grounding tool not accepted")

    text = ""
    try:
        text = response.text or ""
    except Exception:
        # When grounded, .text may raise if there are tool-call parts; assemble manually.
        parts = []
        for cand in getattr(response, "candidates", []) or []:
            for part in getattr(cand.content, "parts", []) or []:
                t = getattr(part, "text", None)
                if t:
                    parts.append(t)
        text = "".join(parts)

    citations: list[GroundingCitation] = []
    for cand in getattr(response, "candidates", []) or []:
        meta = getattr(cand, "grounding_metadata", None)
        if not meta:
            continue
        for chunk in getattr(meta, "grounding_chunks", []) or []:
            web = getattr(chunk, "web", None)
            if not web:
                continue
            citations.append(GroundingCitation(
                title=getattr(web, "title", None),
                url=getattr(web, "uri", None),
            ))
    return GroundedResponse(text=text, citations=citations, provider_used_grounding=True)


def _call_anthropic_grounded(api_key: str, model: str, system: str, user: str, max_tokens: int) -> GroundedResponse:
    """Anthropic with the built-in web_search tool.

    Falls back to a plain (non-grounded) call if the active model doesn't support
    the web_search tool (e.g. older Claude 3.x models).
    """
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    web_tool = {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}

    # ── Attempt 1: standard API with web_search tool ──────────────────────────
    response = None
    grounding_ok = False
    try:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=[web_tool],
            messages=[{"role": "user", "content": user}],
        )
        grounding_ok = True
    except Exception as exc:
        err = str(exc).lower()
        # Model doesn't support the web-search tool (older Claude 3.x etc.)
        if any(kw in err for kw in ("tool", "not support", "unsupported", "invalid", "unknown", "beta")):
            logger.warning(
                "Anthropic model %s does not support web_search tool (%s); "
                "falling back to non-grounded call", model, exc
            )
        else:
            # Unexpected error — re-raise so the caller sees it
            raise

    # ── Attempt 2: plain call if grounding was rejected ───────────────────────
    if not grounding_ok:
        plain = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return GroundedResponse(
            text=plain.content[0].text if plain.content else "",
            citations=[],
            provider_used_grounding=False,
        )

    # ── Parse grounded response ───────────────────────────────────────────────
    text_chunks: list[str] = []
    citations: list[GroundingCitation] = []
    seen_urls: set[str] = set()
    for block in response.content:
        btype = getattr(block, "type", None)
        if btype == "text":
            text_chunks.append(getattr(block, "text", "") or "")
            for cit in (getattr(block, "citations", None) or []):
                url = getattr(cit, "url", None)
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    citations.append(GroundingCitation(
                        title=getattr(cit, "title", None),
                        url=url,
                        snippet=getattr(cit, "cited_text", None),
                    ))
        elif btype == "web_search_tool_result":
            for r in (getattr(block, "content", None) or []):
                url = getattr(r, "url", None)
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    citations.append(GroundingCitation(
                        title=getattr(r, "title", None),
                        url=url,
                    ))
    return GroundedResponse(text="".join(text_chunks), citations=citations, provider_used_grounding=True)


async def call_ai_grounded(
    system: str,
    user: str,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: int = 2048,
    db=None,
) -> GroundedResponse:
    """Like call_ai(), but enables the provider's built-in web grounding when supported.

    Always uses the active provider + model from Settings (DB overrides .env defaults).
    Falls back to a non-grounded call with `provider_used_grounding=False` when:
      - the provider has no native grounding (OpenAI, DeepSeek, custom)
      - the configured model doesn't support the grounding tool (older Claude 3.x etc.)
      - the grounding API call fails for any unexpected reason
    """
    resolved_provider, resolved_model = await get_current_ai_settings(db)
    if provider:
        resolved_provider = provider
    if model:
        resolved_model = model

    logger.info("[grounding] provider=%s model=%s", resolved_provider, resolved_model)

    loop = asyncio.get_event_loop()

    if resolved_provider == "gemini":
        api_key = _get_api_key("gemini_api_key", db)
        if not api_key:
            raise ValueError("Gemini API key not configured")
        try:
            return await loop.run_in_executor(
                None,
                lambda: _call_gemini_grounded(api_key, resolved_model, system, user, max_tokens),
            )
        except Exception as exc:
            logger.warning(
                "[grounding] Gemini grounded call failed for model %s (%s); "
                "falling back to non-grounded", resolved_model, exc
            )
            text = await call_ai(system=system, user=user, provider="gemini",
                                 model=resolved_model, max_tokens=max_tokens, db=db)
            return GroundedResponse(text=text, citations=[], provider_used_grounding=False)

    if resolved_provider == "anthropic":
        api_key = _get_api_key("anthropic_api_key", db)
        if not api_key:
            raise ValueError("Anthropic API key not configured")
        try:
            return await loop.run_in_executor(
                None,
                lambda: _call_anthropic_grounded(api_key, resolved_model, system, user, max_tokens),
            )
        except Exception as exc:
            logger.warning(
                "[grounding] Anthropic grounded call failed for model %s (%s); "
                "falling back to non-grounded", resolved_model, exc
            )
            text = await call_ai(system=system, user=user, provider="anthropic",
                                 model=resolved_model, max_tokens=max_tokens, db=db)
            return GroundedResponse(text=text, citations=[], provider_used_grounding=False)

    # Providers without native grounding (OpenAI, DeepSeek, custom) — use configured
    # model for the answer, just without live web search.
    logger.info(
        "[grounding] provider %s has no native grounding; using %s without web search",
        resolved_provider, resolved_model
    )
    text = await call_ai(system=system, user=user, provider=resolved_provider,
                         model=resolved_model, max_tokens=max_tokens, db=db)
    return GroundedResponse(text=text, citations=[], provider_used_grounding=False)
