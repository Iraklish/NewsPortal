"""Fetch tweets from X/Twitter via twikit (unofficial) and store as Articles.

Login happens once from the Twitter page (credentials are used to obtain session
cookies, which are persisted to backend/twitter_cookies.json — the password is
NOT stored). Subsequent fetches reuse the cookies.

Each tweet becomes an Article with url ``https://x.com/<user>/status/<id>``
(sha-256 hashed for dedup), category ``twitter``. Tweet media URLs are public
CDN links, stored directly in image_url/media_urls (no download needed).

⚠ Unofficial — scrapes X via your account session, against X's ToS. Use a
number/account you are willing to risk; fetch sparingly to avoid rate limits.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..models import Article, TwitterSource
from .dedup import url_hash

logger = logging.getLogger(__name__)

_COOKIES_PATH = Path(__file__).resolve().parent.parent.parent / "twitter_cookies.json"
_lock: Optional[asyncio.Lock] = None


def _patch_twikit_transaction() -> None:
    """Fix twikit's x-client-transaction ondemand-file lookup for X's current
    webpack layout. X now emits ``<chunkId>:"ondemand.s"`` plus a separate
    ``<chunkId>:"<hash>"`` map entry, so the bundled inline regex finds nothing
    and login/fetch fail with "Couldn't get KEY_BYTE indices". This resolves the
    hash via the chunk map (falling back to the old format).
    """
    try:
        import re as _re
        from twikit.x_client_transaction import transaction as _tx

        async def get_indices(self, home_page_response, session, headers):
            response = self.validate_response(home_page_response) or self.home_page_response
            html = str(response)
            url = None
            m = _re.search(r'(\d+):"ondemand\.s"', html)
            if m:
                hm = _re.search(m.group(1) + r':"([0-9a-f]+)"', html)
                if hm:
                    url = f"https://abs.twimg.com/responsive-web/client-web/ondemand.s.{hm.group(1)}a.js"
            if url is None:
                old = _tx.ON_DEMAND_FILE_REGEX.search(html)
                if old:
                    url = f"https://abs.twimg.com/responsive-web/client-web/ondemand.s.{old.group(1)}a.js"
            indices: list = []
            if url:
                resp = await session.request(method="GET", url=url, headers=headers)
                for item in _tx.INDICES_REGEX.finditer(str(resp.text)):
                    indices.append(item.group(2))
            if not indices:
                raise Exception("Couldn't get KEY_BYTE indices")
            indices = list(map(int, indices))
            return indices[0], indices[1:]

        _tx.ClientTransaction.get_indices = get_indices
        logger.info("[twitter] applied twikit ondemand transaction-id patch")
    except Exception as exc:
        logger.warning("[twitter] could not patch twikit transaction: %s", exc)


_USER_LEGACY_DEFAULTS = {
    "created_at": None, "name": "", "screen_name": "", "profile_image_url_https": None,
    "location": "", "description": "", "pinned_tweet_ids_str": [],
    "verified": False, "possibly_sensitive": False, "can_dm": False, "can_media_tag": False,
    "want_retweets": False, "default_profile": False, "default_profile_image": False,
    "has_custom_timelines": False, "followers_count": 0, "fast_followers_count": 0,
    "normal_followers_count": 0, "friends_count": 0, "favourites_count": 0, "listed_count": 0,
    "media_count": 0, "statuses_count": 0, "is_translator": False, "translator_type": "",
    "withheld_in_countries": [],
}


def _patch_twikit_user() -> None:
    """X has dropped/relocated many ``legacy`` user fields (e.g. empty
    ``entities.description``, missing ``pinned_tweet_ids_str``), but twikit reads
    them directly and KeyErrors. Fill missing fields with safe defaults so a
    User parses; we mainly need the user id.
    """
    try:
        import twikit.user as _U
        _orig_init = _U.User.__init__

        def _init(self, client, data):
            try:
                if isinstance(data, dict):
                    data.setdefault("is_blue_verified", False)
                    legacy = data.setdefault("legacy", {})
                    if isinstance(legacy, dict):
                        # Pull name/screen_name from core if legacy lost them (newer X format).
                        core = (data.get("core") or {})
                        for k in ("name", "screen_name"):
                            if not legacy.get(k) and core.get(k):
                                legacy[k] = core[k]
                        for k, v in _USER_LEGACY_DEFAULTS.items():
                            legacy.setdefault(k, list(v) if isinstance(v, list) else v)
                        ent = legacy.setdefault("entities", {})
                        if isinstance(ent, dict):
                            desc = ent.setdefault("description", {})
                            if isinstance(desc, dict):
                                desc.setdefault("urls", [])
                            url = ent.get("url")
                            if isinstance(url, dict):
                                url.setdefault("urls", [])
            except Exception:
                pass
            _orig_init(self, client, data)

        _U.User.__init__ = _init
        logger.info("[twitter] applied twikit User legacy-defaults patch")
    except Exception as exc:
        logger.warning("[twitter] could not patch twikit User: %s", exc)


_patch_twikit_transaction()
_patch_twikit_user()


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


def _new_client():
    from twikit import Client
    return Client("en-US")


def is_authenticated() -> bool:
    return _COOKIES_PATH.exists()


async def login(username: str, email: str | None, password: str, totp_secret: str | None = None) -> bool:
    """Log in to X and persist session cookies. Returns True on success.

    The 'UI metrics' JS challenge (enable_ui_metrics) fails on some setups with
    "Couldn't get KEY_BYTE indices"; retry with it disabled in that case.
    """
    kwargs = dict(
        auth_info_1=username,
        auth_info_2=email or None,
        password=password,
        totp_secret=totp_secret or None,
    )
    async with _get_lock():
        client = _new_client()
        try:
            await client.login(enable_ui_metrics=False, **kwargs)
        except TypeError:
            # Older twikit without the enable_ui_metrics kwarg.
            client = _new_client()
            await client.login(**kwargs)
        except Exception as exc:
            if "KEY_BYTE" in str(exc) or "ui_metrics" in str(exc).lower():
                client = _new_client()
                await client.login(enable_ui_metrics=True, **kwargs)
            else:
                raise
        client.save_cookies(str(_COOKIES_PATH))
    return True


async def login_with_cookies(auth_token: str, ct0: str) -> bool:
    """Authenticate using cookies copied from a browser session — bypasses the
    Cloudflare-protected login flow. Needs at least auth_token and ct0."""
    auth_token = (auth_token or "").strip()
    ct0 = (ct0 or "").strip()
    if not auth_token or not ct0:
        raise ValueError("Both auth_token and ct0 cookies are required")
    client = _new_client()
    async with _get_lock():
        client.set_cookies({"auth_token": auth_token, "ct0": ct0})
        client.save_cookies(str(_COOKIES_PATH))
    return True


def logout() -> None:
    try:
        _COOKIES_PATH.unlink(missing_ok=True)
    except Exception:
        pass


async def _client_with_cookies():
    if not _COOKIES_PATH.exists():
        raise RuntimeError("Not logged in to X — sign in on the Twitter page first")
    client = _new_client()
    client.load_cookies(str(_COOKIES_PATH))
    return client


async def check_auth() -> dict:
    """Report whether a stored session exists.

    We intentionally do NOT make a live X call here: X's Cloudflare anti-bot can
    reject the probe even when the cookies are valid, which would wrongly show
    the UI as logged out. The real validity test is an actual fetch, whose error
    is surfaced to the user.
    """
    return {"authenticated": _COOKIES_PATH.exists()}


async def verify_session() -> dict:
    """Live check that the stored session can read from X (used post cookie-set)."""
    if not _COOKIES_PATH.exists():
        return {"ok": False, "error": "no session"}
    try:
        client = await _client_with_cookies()
        await client.get_user_by_screen_name("X")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}


def _best_variant_url(entry: dict) -> str | None:
    """Pick the highest-bitrate playable URL for a video / animated_gif entry."""
    variants = ((entry.get("video_info") or {}).get("variants")) or []
    best, best_br = None, -1
    for v in variants:
        url = v.get("url")
        if not url:
            continue
        ctype = v.get("content_type") or ""
        br = v.get("bitrate") or 0
        # Prefer progressive mp4; treat m3u8 (bitrate often absent) as last resort.
        score = br if "mp4" in ctype else -1
        if score > best_br:
            best_br, best = score, url
    return best


def _extract_media(tw) -> tuple[list[str], str | None]:
    """Return (media_urls, poster_image_url) for ALL media on a tweet.

    twikit's ``Tweet.media`` reads ``entities.media`` which only ever holds the
    first item; the complete set (up to 4) lives in ``extended_entities.media``.
    We read that directly and, for videos/GIFs, resolve the best playable URL
    (not just the static thumbnail). ``poster`` is the first image we can show.
    """
    media_urls: list[str] = []
    poster: str | None = None
    try:
        entries = (tw._legacy.get("extended_entities") or {}).get("media") or []
    except Exception:
        entries = []
    if not entries:
        try:
            entries = (tw._legacy.get("entities") or {}).get("media") or []
        except Exception:
            entries = []

    for entry in entries:
        mtype = entry.get("type")
        thumb = entry.get("media_url_https") or entry.get("media_url")
        if mtype in ("video", "animated_gif"):
            playable = _best_variant_url(entry)
            if playable:
                media_urls.append(playable)
            if thumb:
                poster = poster or thumb
        else:  # photo (or unknown → treat as image)
            if thumb:
                media_urls.append(thumb)
                poster = poster or thumb

    # Deduplicate while preserving order.
    seen: set[str] = set()
    ordered = [u for u in media_urls if not (u in seen or seen.add(u))]
    return ordered, poster


def _post_text(tw) -> str:
    """Full tweet text, expanding long-form note tweets (full_text handles this)."""
    return (getattr(tw, "full_text", None) or getattr(tw, "text", "") or "").strip()


def _extract_post(tw) -> tuple[str, list[str], str | None]:
    """Assemble the WHOLE post: full text + all media, unwrapping retweets and
    appending quoted-tweet text/media so nothing is lost.

    Returns (text, media_urls, image_url).
    """
    # Retweets carry a truncated "RT @user: …" body; pull the original instead.
    rt = None
    try:
        rt = tw.retweeted_tweet
    except Exception:
        rt = None
    base = rt or tw

    text = _post_text(base)
    media, poster = _extract_media(base)
    if rt is not None:
        rt_author = getattr(getattr(rt, "user", None), "screen_name", None)
        text = f"RT @{rt_author}: {text}" if rt_author else text

    # Append a quoted tweet's content (quote tweets embed another post).
    quoted = None
    try:
        quoted = tw.quote
    except Exception:
        quoted = None
    if quoted is not None:
        q_text = _post_text(quoted)
        q_media, q_poster = _extract_media(quoted)
        q_author = getattr(getattr(quoted, "user", None), "screen_name", None)
        header = f"\n\n— Quoting @{q_author}:" if q_author else "\n\n— Quoting:"
        if q_text or q_media:
            text = (text + header + (f"\n{q_text}" if q_text else "")).strip()
            media = media + [m for m in q_media if m not in media]
            poster = poster or q_poster

    return text, media, poster


def _tweet_url(screen_name: str, tweet_id) -> str:
    return f"https://x.com/{screen_name or 'i'}/status/{tweet_id}"


async def _fetch_source_tweets(client, source: TwitterSource):
    kind = (source.kind or "user").lower()
    if kind == "list":
        return await client.get_list_tweets(source.handle, count=40)
    if kind == "search":
        return await client.search_tweet(source.handle, "Latest", count=40)
    # default: user timeline
    user = await client.get_user_by_screen_name(source.handle.lstrip("@"))
    return await client.get_user_tweets(user.id, "Tweets", count=40)


async def fetch_twitter_source(source: TwitterSource, db: Session, client=None) -> list[int]:
    """Fetch recent tweets for one source. Returns inserted Article IDs."""
    new_ids: list[int] = []
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=source.lookback_hours)
    own_client = client is None
    try:
        if own_client:
            client = await _client_with_cookies()
        tweets = await _fetch_source_tweets(client, source)
    except Exception as exc:
        logger.warning("[twitter] fetch failed for %s: %s", source.handle, exc)
        source.last_status = "error"
        source.last_error = str(exc)[:512]
        _commit(db)
        return []

    for tw in tweets:
        try:
            created = getattr(tw, "created_at_datetime", None)
            ts = created.replace(tzinfo=None) if created else None
        except Exception:
            ts = None
        if ts and ts < cutoff:
            continue

        text, media, image_url = _extract_post(tw)
        if not text and not media:
            continue

        author = getattr(getattr(tw, "user", None), "screen_name", None) or source.handle.lstrip("@")
        author_name = getattr(getattr(tw, "user", None), "name", None)
        u = _tweet_url(author, tw.id)
        u_hash = url_hash(u)
        if db.query(Article).filter(Article.url_hash == u_hash).first():
            continue

        first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")[:200]
        article = Article(
            url=u,
            url_hash=u_hash,
            title=first_line or ("Media tweet" if media else None),
            source=f"@{author}" + (f" · {source.name}" if source.kind != "user" and source.name else ""),
            author=author_name,
            category="twitter",
            published_at=ts,
            content=text,
            image_url=image_url or (media[0] if media else None),
            media_urls=media,
            is_analyzed=False,
        )
        db.add(article)
        try:
            db.flush()
            new_ids.append(article.id)
        except Exception:
            db.rollback()
            logger.warning("[twitter] failed to store tweet %s", tw.id)

    source.last_fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    source.last_status = "ok" if new_ids else "empty"
    source.last_error = None
    _commit(db)
    if own_client:
        # twikit's client has no explicit close; rely on GC.
        pass
    return new_ids


async def fetch_all_twitter_sources(db: Session) -> list[int]:
    """Manual fetch for all enabled Twitter sources (reuses one client)."""
    sources = db.query(TwitterSource).filter(TwitterSource.enabled == True).all()  # noqa: E712
    if not sources:
        return []
    if not _COOKIES_PATH.exists():
        logger.debug("[twitter] not logged in — skipping fetch")
        return []
    all_ids: list[int] = []
    async with _get_lock():
        try:
            client = await _client_with_cookies()
        except Exception as exc:
            logger.warning("[twitter] client init failed: %s", exc)
            return []
        for src in sources:
            try:
                all_ids.extend(await fetch_twitter_source(src, db, client=client))
            except Exception as exc:
                logger.warning("[twitter] source %s failed: %s", src.handle, exc)
            await asyncio.sleep(1.0)  # be gentle with rate limits
    if all_ids:
        logger.info("[twitter] fetched %d new tweet(s) from %d source(s)", len(all_ids), len(sources))
    return all_ids


def _commit(db: Session) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
