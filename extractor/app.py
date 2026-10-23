from __future__ import annotations

import base64
import hmac
import importlib.util
import json
import subprocess
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlparse, urlunparse

import yt_dlp
from fastapi import FastAPI, Header, HTTPException
from curl_cffi import requests as curl_requests
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from yt_dlp.utils import DownloadError


MAX_DURATION_SECONDS = 20 * 60
MAX_FILE_BYTES = 150 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
ALLOWED_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
POST_PATH = re.compile(r"^/(?:reel|reels|p|tv)/[A-Za-z0-9_-]+/?$", re.IGNORECASE)
QUALITY_PRESETS = {"128", "192", "256", "320"}
ACTIVE_JOBS = threading.BoundedSemaphore(value=2)

# Reuse one authenticated client per worker so rotated cookies/device state are not
# thrown away after every conversion. Render's filesystem is ephemeral, so the
# environment remains the safe bootstrap; this file only helps within one instance.
INSTAGRAPI_SETTINGS_PATH = Path("/tmp/reeltone-instagrapi-settings.json")
INSTAGRAPI_AUTH_COOLDOWN_SECONDS = 15 * 60
INSTAGRAPI_RATE_COOLDOWN_SECONDS = 5 * 60
_INSTAGRAPI_LOCK = threading.RLock()
_INSTAGRAPI_STATE = {
    "client": None,
    "mode": "disabled",
    "retry_after": 0.0,
    "reauth_retry_after": 0.0,
}

app = FastAPI(
    title="ReelTone Impersonated Extractor",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class ConvertRequest(BaseModel):
    url: str = Field(min_length=12, max_length=2048)
    quality: Literal["128", "192", "256", "320"] = "192"
    strategy: Literal[
        "auto", "gallery-dl-only", "instagrapi-only", "rate-limit-fallback"
    ] = "auto"


class ThumbnailRequest(BaseModel):
    url: str = Field(min_length=12, max_length=2048)


def clean_metadata(value: object, maximum: int = 180) -> str:
    raw = str(value or "")
    return re.sub(r"[\r\n\x00-\x1f\x7f]", " ", raw).strip()[:maximum]


def canonical_public_instagram_url(raw: str) -> str:
    try:
        parsed = urlparse(raw.strip())
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or host not in ALLOWED_HOSTS
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 443)
            or not POST_PATH.fullmatch(parsed.path)
        ):
            raise ValueError("invalid")
        # Drop tracking parameters and fragments before making any request.
        canonical = parsed._replace(
            netloc="www.instagram.com",
            params="",
            query="",
            fragment="",
        )
        return urlunparse(canonical)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_URL", "error": "Use a public Instagram Reel or video post URL."},
        )


def make_cleanup(directory: Path):
    def cleanup() -> None:
        shutil.rmtree(directory, ignore_errors=True)
        try:
            ACTIVE_JOBS.release()
        except ValueError:
            # Defensive guard: every accepted request releases exactly once.
            pass
    return cleanup


def safe_download_error(error: Exception) -> tuple[int, str, str]:
    message = str(error).lower()
    if any(term in message for term in ("video is longer", "duration limit", "longer than", "max duration")):
        return 413, "VIDEO_TOO_LONG", "This Reel exceeds the 20-minute conversion limit."
    if any(term in message for term in ("private account", "private reel", "login required", "login_required", "sign in to view")):
        return 422, "LOGIN_REQUIRED", "Instagram requires access this public-only converter cannot provide."
    if any(term in message for term in ("not found", "does not exist", "removed", "deleted", "404")):
        return 404, "REEL_UNAVAILABLE", "Instagram did not return this Reel's media."
    if any(term in message for term in ("empty media response", "no formats", "no video formats", "no video data", "no publicly available")):
        return 422, "NO_PUBLIC_MEDIA", "Instagram did not expose a playable stream to the extractor."
    if any(term in message for term in ("429", "too many requests", "rate limit", "please wait")):
        return 503, "SOURCE_RATE_LIMITED", "Instagram temporarily limited this extraction request."
    return 503, "EXTRACTOR_UNAVAILABLE", "The impersonated extractor could not retrieve playable media."


def require_service_token(authorization: str | None) -> None:
    expected = os.environ.get("REELTONE_EXTRACTOR_TOKEN", "").strip()
    if len(expected) < 32:
        raise HTTPException(status_code=503, detail={"code": "SERVICE_NOT_CONFIGURED"})
    provided = authorization or ""
    if not provided.startswith("Bearer ") or not hmac.compare_digest(provided[7:].strip(), expected):
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED"})



GRAPHQL_DOC_ID = "27128499623469141"
INSTAGRAM_APP_ID = "936619743392459"
ALLOWED_MEDIA_SUFFIXES = (".cdninstagram.com", ".fbcdn.net")


def allowed_instagram_media_url(raw: str) -> str | None:
    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not (
            host == "cdninstagram.com"
            or host.endswith(ALLOWED_MEDIA_SUFFIXES)
        ):
            return None
        return raw
    except Exception:
        return None



def download_public_thumbnail(session, item: dict, directory: Path) -> Path | None:
    """Fetch only a bounded image from a validated Instagram CDN host."""
    versions = item.get("image_versions2") or {}
    raw_candidates = list(versions.get("candidates") or [])
    raw_candidates.extend(item.get("thumbnail_resources") or [])
    for key in ("thumbnail_url", "display_url", "thumbnail_src"):
        if item.get(key):
            raw_candidates.append({"url": item[key], "width": 0, "height": 0})

    unique: dict[str, tuple[int, str]] = {}
    for candidate in raw_candidates:
        raw_url = candidate.get("url") or candidate.get("src")
        if not isinstance(raw_url, str):
            continue
        safe_url = allowed_instagram_media_url(raw_url)
        if not safe_url:
            continue
        try:
            pixels = int(candidate.get("width") or 0) * int(candidate.get("height") or 0)
        except (TypeError, ValueError):
            pixels = 0
        unique[safe_url] = (pixels, safe_url)

    for _pixels, image_url in sorted(unique.values(), reverse=True):
        response = None
        image_path = directory / "graphql-cover"
        try:
            response = session.get(image_url, stream=True, timeout=12)
            final_url = allowed_instagram_media_url(str(getattr(response, "url", image_url)))
            if response.status_code == 429 or not response.ok or not final_url:
                continue

            content_type = str(response.headers.get("content-type", "")).split(";", 1)[0].strip().lower()
            if content_type not in {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif"}:
                continue
            try:
                declared_size = int(response.headers.get("content-length", "0"))
            except (TypeError, ValueError):
                declared_size = 0
            if declared_size > MAX_THUMBNAIL_BYTES:
                continue

            received = 0
            with image_path.open("wb") as output:
                for chunk in response.iter_content(chunk_size=32 * 1024):
                    if not chunk:
                        continue
                    received += len(chunk)
                    if received > MAX_THUMBNAIL_BYTES:
                        raise ValueError("thumbnail too large")
                    output.write(chunk)
            if received >= 128:
                return image_path
        except Exception:
            image_path.unlink(missing_ok=True)
            continue
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass

    return None


def try_graphql_public_media(
    source_url: str,
    shortcode: str,
    directory: Path,
    quality: str,
) -> dict | None:
    """Direct anonymous GraphQL fallback for public Reels when the HTML extractor is gated."""
    session = None
    source_file = directory / "graphql-source.bin"
    audio_file = directory / "graphql-audio.mp3"

    try:
        # Let curl-cffi keep the fingerprint and User-Agent paired. This is an
        # anonymous session used only to establish a CSRF token, not an account login.
        session = curl_requests.Session(
            impersonate="chrome",
            headers={
                "Referer": "https://www.instagram.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        landing = session.get("https://www.instagram.com/", timeout=15)
        if landing.status_code == 429:
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": "30"},
                detail={"code": "SOURCE_RATE_LIMITED", "error": "Instagram temporarily limited anonymous extraction."},
            )
        landing.raise_for_status()

        csrf = session.cookies.get("csrftoken")
        if not csrf:
            return None

        variables = {
            "shortcode": shortcode,
            "__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider": False,
        }
        response = session.post(
            "https://www.instagram.com/graphql/query",
            data={
                "doc_id": GRAPHQL_DOC_ID,
                "variables": json.dumps(variables, separators=(",", ":")),
            },
            headers={
                "X-CSRFToken": csrf,
                "X-IG-App-ID": INSTAGRAM_APP_ID,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=18,
        )

        if response.status_code == 429:
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": "30"},
                detail={"code": "SOURCE_RATE_LIMITED", "error": "Instagram temporarily limited anonymous extraction."},
            )
        if not response.ok:
            return None

        payload = response.json()
        errors = payload.get("errors") or []
        if any(
            str(error.get("code", "")) == "1675004"
            or "rate limit" in str(error.get("message", "")).lower()
            for error in errors
        ):
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": "30"},
                detail={"code": "SOURCE_RATE_LIMITED", "error": "Instagram temporarily limited anonymous extraction."},
            )

        web_info = (
            ((payload.get("data") or {}).get("xdt_api__v1__media__shortcode__web_info"))
            or {}
        )
        items = web_info.get("items") or []
        if not items:
            # This query has occasional execution errors even for otherwise public
            # posts. Let yt-dlp try its own extractor instead of treating this as final.
            return None

        item = items[0]
        versions = item.get("video_versions") or []
        media_url = item.get("video_url") or (versions[0].get("url") if versions else None)
        if not media_url:
            return None
        if item.get("media_type") not in (2, "2") and not versions:
            return None

        duration = item.get("video_duration")
        try:
            if duration is not None and float(duration) > MAX_DURATION_SECONDS:
                raise HTTPException(
                    status_code=413,
                    detail={"code": "VIDEO_TOO_LONG", "error": "This Reel exceeds the 20-minute conversion limit."},
                )
        except (TypeError, ValueError):
            pass

        media_url = allowed_instagram_media_url(str(media_url))
        if not media_url:
            return None

        media_response = session.get(media_url, stream=True, timeout=30)
        if media_response.status_code == 429:
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": "30"},
                detail={"code": "SOURCE_RATE_LIMITED", "error": "Instagram temporarily limited media retrieval."},
            )
        if not media_response.ok:
            return None

        content_type = str(media_response.headers.get("content-type", "")).lower()
        if content_type.startswith("text/") or "application/json" in content_type:
            return None

        try:
            declared_size = int(media_response.headers.get("content-length", "0"))
        except (TypeError, ValueError):
            declared_size = 0
        if declared_size > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})

        received = 0
        with source_file.open("wb") as output:
            for chunk in media_response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                received += len(chunk)
                if received > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})
                output.write(chunk)
        if received < 128:
            source_file.unlink(missing_ok=True)
            return None

        user = item.get("user") or item.get("owner") or {}
        caption = item.get("caption")
        if isinstance(caption, dict):
            caption = caption.get("text")
        title = clean_metadata(item.get("title") or caption or ("Instagram Reel " + shortcode), 160)
        author = clean_metadata(
            user.get("full_name") or user.get("username") or "",
            80,
        )
        cover_path = download_public_thumbnail(session, item, directory)

        ffmpeg = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"

        def encode(include_cover: bool):
            args = [
                ffmpeg,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", str(source_file),
            ]
            if include_cover and cover_path is not None:
                args.extend(["-i", str(cover_path)])
            args.extend([
                "-map", "0:a:0",
                "-codec:a", "libmp3lame",
                "-b:a", f"{quality}k",
                "-map_metadata", "-1",
                "-metadata", "title=" + title,
                "-metadata", "album=Instagram Reels",
                "-metadata", "comment=Converted with ReelTone",
                "-id3v2_version", "3",
            ])
            if author:
                args.extend(["-metadata", "artist=" + author])
            if include_cover and cover_path is not None:
                args.extend([
                    "-map", "1:v:0",
                    "-codec:v", "mjpeg",
                    "-disposition:v:0", "attached_pic",
                ])
            else:
                args.append("-vn")
            args.extend(["-f", "mp3", str(audio_file)])
            return subprocess.run(
                args,
                capture_output=True,
                check=False,
                timeout=60,
            )

        result = None
        if cover_path is not None:
            try:
                result = encode(include_cover=True)
            except Exception:
                result = None
        if result is None or result.returncode != 0:
            # Cover art is an enhancement, never a reason to lose otherwise
            # playable audio. Retry once without artwork if tagging it fails.
            audio_file.unlink(missing_ok=True)
            try:
                result = encode(include_cover=False)
            except Exception:
                result = None

        source_file.unlink(missing_ok=True)
        if cover_path is not None:
            cover_path.unlink(missing_ok=True)
        if result is None or result.returncode != 0 or not audio_file.exists() or audio_file.stat().st_size < 128:
            audio_file.unlink(missing_ok=True)
            return None

        return {
            "title": title,
            "uploader": author,
            "_extractor": "instagram-graphql",
        }
    except HTTPException:
        raise
    except Exception:
        # Do not log signed media URLs, cookie contents, captions, or raw Instagram payloads.
        source_file.unlink(missing_ok=True)
        audio_file.unlink(missing_ok=True)
        return None
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass


@app.get("/health")
def health():
    # Publish only configuration booleans, never session values or cookie data.
    return {
        "ok": True,
        "service": "reeltone-impersonated-extractor",
        "engine": "yt-dlp",
        "browserImpersonation": True,
        "ffmpegAvailable": shutil.which("ffmpeg") is not None,
        "instagrapiInstalled": importlib.util.find_spec("instagrapi") is not None,
        "instagrapiSessionConfigured": instagrapi_is_configured(),
        "instagrapiAutoRenewConfigured": (
            os.environ.get("INSTAGRAPI_AUTO_REAUTH", "").strip().lower() in {"1", "true", "yes", "on"}
            and bool(os.environ.get("INSTAGRAPI_USERNAME", "").strip())
            and bool(os.environ.get("INSTAGRAPI_PASSWORD", ""))
        ),
        "instagrapiAuthMode": instagrapi_status()[0],
        "instagrapiClientLoaded": instagrapi_status()[1],
        "instagrapiCooldownActive": instagrapi_status()[2],
    }



def thumbnail_content_type(image_path: Path) -> str | None:
    header = image_path.read_bytes()[:32]
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    if len(header) >= 12 and header[4:8] == b"ftyp" and any(kind in header[8:24] for kind in (b"avif", b"avis")):
        return "image/avif"
    return None


@app.post("/thumbnail")
def thumbnail(
    payload: ThumbnailRequest,
    authorization: str | None = Header(default=None),
):
    """Best-effort cover-art lookup for successful primary-provider downloads."""
    require_service_token(authorization)
    source_url = canonical_public_instagram_url(payload.url)
    shortcode_match = re.search(r"/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", urlparse(source_url).path)
    shortcode = shortcode_match.group(1) if shortcode_match else ""
    if not shortcode:
        raise HTTPException(status_code=400, detail={"code": "INVALID_URL"})

    if not ACTIVE_JOBS.acquire(blocking=False):
        raise HTTPException(status_code=503, headers={"Retry-After": "5"}, detail={"code": "EXTRACTOR_BUSY"})

    directory = Path(tempfile.mkdtemp(prefix="reeltone-cover-"))
    cleanup = make_cleanup(directory)
    keep_for_response = False
    session = None

    try:
        session = curl_requests.Session(
            impersonate="chrome",
            headers={
                "Referer": "https://www.instagram.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        landing = session.get("https://www.instagram.com/", timeout=8)
        if landing.status_code == 429:
            raise HTTPException(status_code=503, headers={"Retry-After": "30"}, detail={"code": "SOURCE_RATE_LIMITED"})
        landing.raise_for_status()
        csrf = session.cookies.get("csrftoken")
        if not csrf:
            raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})

        response = session.post(
            "https://www.instagram.com/graphql/query",
            data={
                "doc_id": GRAPHQL_DOC_ID,
                "variables": json.dumps({
                    "shortcode": shortcode,
                    "__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider": False,
                }, separators=(",", ":")),
            },
            headers={
                "X-CSRFToken": csrf,
                "X-IG-App-ID": INSTAGRAM_APP_ID,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=8,
        )
        if response.status_code == 429:
            raise HTTPException(status_code=503, headers={"Retry-After": "30"}, detail={"code": "SOURCE_RATE_LIMITED"})
        if not response.ok:
            raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})

        data = response.json()
        errors = data.get("errors") or []
        if any(
            str(error.get("code", "")) == "1675004"
            or "rate limit" in str(error.get("message", "")).lower()
            for error in errors
        ):
            raise HTTPException(status_code=503, headers={"Retry-After": "30"}, detail={"code": "SOURCE_RATE_LIMITED"})

        web_info = ((data.get("data") or {}).get("xdt_api__v1__media__shortcode__web_info")) or {}
        items = web_info.get("items") or []
        if not items:
            raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})
        item = items[0]

        image_path = download_public_thumbnail(session, item, directory)
        if not image_path:
            raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})
        content_type = thumbnail_content_type(image_path)
        if not content_type or image_path.stat().st_size > MAX_THUMBNAIL_BYTES:
            image_path.unlink(missing_ok=True)
            raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})

        user = item.get("user") or item.get("owner") or {}
        caption = item.get("caption")
        if isinstance(caption, dict):
            caption = caption.get("text")
        title = clean_metadata(item.get("title") or caption or ("Instagram Reel " + shortcode), 160)
        author = clean_metadata(user.get("full_name") or user.get("username") or "", 80)
        headers = {
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "Content-Length": str(image_path.stat().st_size),
            "X-ReelTone-Title": quote(title, safe=""),
            "X-ReelTone-Author": quote(author, safe=""),
        }
        filename = "reeltone-cover" + {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/avif": ".avif",
        }[content_type]
        result = FileResponse(
            path=image_path,
            media_type=content_type,
            filename=filename,
            headers=headers,
            background=BackgroundTask(cleanup),
        )
        keep_for_response = True
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail={"code": "NO_PUBLIC_THUMBNAIL"})
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass
        if not keep_for_response:
            cleanup()



def instagrapi_is_configured() -> bool:
    settings_present = bool(
        os.environ.get("INSTAGRAPI_SETTINGS_JSON", "").strip()
        or os.environ.get("INSTAGRAPI_SETTINGS_B64", "").strip()
        or INSTAGRAPI_SETTINGS_PATH.is_file()
    )
    sessionid_present = bool(os.environ.get("INSTAGRAPI_SESSIONID", "").strip())
    auto_renew = os.environ.get("INSTAGRAPI_AUTO_REAUTH", "").strip().lower() in {"1", "true", "yes", "on"}
    credentials_present = bool(
        auto_renew
        and os.environ.get("INSTAGRAPI_USERNAME", "").strip()
        and os.environ.get("INSTAGRAPI_PASSWORD", "")
    )
    return settings_present or sessionid_present or credentials_present


def instagrapi_status() -> tuple[str, bool, bool]:
    """Return non-secret readiness details for the health endpoint."""
    with _INSTAGRAPI_LOCK:
        return (
            str(_INSTAGRAPI_STATE["mode"]),
            _INSTAGRAPI_STATE["client"] is not None,
            float(_INSTAGRAPI_STATE["retry_after"]) > time.monotonic(),
        )


def _close_instagrapi_client(client: object | None) -> None:
    if client is None:
        return
    for session_name in ("private", "public", "graphql"):
        session = getattr(client, session_name, None)
        close = getattr(session, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def _instagrapi_error_kind(error: Exception) -> str:
    """Classify failures without logging exception text or signed URLs."""
    name = type(error).__name__.lower()
    message = str(error).lower()
    if (
        "throttled" in name
        or "ratelimit" in name
        or "rate limit" in message
        or "too many requests" in message
        or "http 429" in message
        or "status code 429" in message
        or "please wait" in message
        or "feedback_required" in message
    ):
        return "rate-limited"
    if (
        "loginrequired" in name
        or "login_required" in message
        or "user_has_logged_out" in message
        or "userhasloggedout" in name
        or "session expired" in message
        or "session has expired" in message
        or "not authenticated" in message
        or "authentication required" in message
        or "not logged in" in message
        or "login required" in message
    ):
        return "expired-session"
    if "challenge" in name or "checkpoint" in message or "challenge_required" in message:
        return "challenge-required"
    return "unavailable"


def _build_instagrapi_client(require_renewal: bool = False):
    """Load the best saved authorization and optionally let Instagrapi renew it.

    INSTAGRAPI_USERNAME/PASSWORD are optional Render secrets. When supplied with
    saved settings, Client.login() validates/reuses them and can relogin if the
    prior authorization is stale. Raw browser sessionid alone cannot be renewed
    indefinitely; it is retained as a compatibility bootstrap only.
    """
    from instagrapi import Client

    client = Client()
    client.set_retry_config(
        request_timeout=18,
        session_retry_total=0,
        session_retry_backoff_factor=0,
        session_retry_statuses=[],
    )

    settings_raw = os.environ.get("INSTAGRAPI_SETTINGS_JSON", "").strip()
    settings_b64 = os.environ.get("INSTAGRAPI_SETTINGS_B64", "").strip()
    username = os.environ.get("INSTAGRAPI_USERNAME", "").strip()
    password = os.environ.get("INSTAGRAPI_PASSWORD", "")
    auto_reauth = os.environ.get("INSTAGRAPI_AUTO_REAUTH", "").strip().lower() in {"1", "true", "yes", "on"}
    has_credentials = bool(auto_reauth and username and password)
    sessionid = os.environ.get("INSTAGRAPI_SESSIONID", "").strip()
    mode = "disabled"

    if settings_raw or settings_b64:
        settings = (
            json.loads(settings_raw)
            if settings_raw
            else json.loads(base64.b64decode(settings_b64, validate=True).decode("utf-8"))
        )
        if not isinstance(settings, dict) or not settings:
            raise ValueError("invalid Instagrapi settings")
        client.set_settings(settings)
        mode = "settings"
    elif INSTAGRAPI_SETTINGS_PATH.is_file():
        client.load_settings(str(INSTAGRAPI_SETTINGS_PATH))
        mode = "cached-settings"
    elif sessionid:
        try:
            client.login_by_sessionid(sessionid)
            mode = "sessionid"
        except Exception as session_error:
            # If the imported browser session has expired, one password login is
            # allowed only when the operator explicitly enabled auto reauth.
            if not has_credentials or _instagrapi_error_kind(session_error) in {"rate-limited", "challenge-required"}:
                raise
            if not client.login(username, password):
                raise RuntimeError("Instagrapi credential login was not accepted")
            mode = "password"
    elif has_credentials:
        if not client.login(username, password):
            raise RuntimeError("Instagrapi credential login was not accepted")
        mode = "password"
    else:
        _close_instagrapi_client(client)
        return None, "disabled"

    if has_credentials and mode in {"settings", "cached-settings", "sessionid"}:
        # Explicit opt-in only. During initial boot, keep an accepted browser
        # session if the password login flow is rejected by Instagram; during
        # recovery, fail closed if the stale saved authorization cannot be renewed.
        try:
            if not client.login(username, password):
                raise RuntimeError("Instagrapi saved-session renewal was not accepted")
            mode = "settings+password-renewal"
        except Exception:
            if require_renewal:
                raise
            if mode == "sessionid":
                mode = "sessionid-renewal-failed"
            else:
                mode = "settings-renewal-failed"

    return client, mode


def _persist_instagrapi_settings(client: object) -> None:
    """Persist rotated settings to owner-only ephemeral storage; never print them."""
    temporary = INSTAGRAPI_SETTINGS_PATH.with_suffix(".tmp")
    try:
        dump = getattr(client, "dump_settings", None)
        if not callable(dump):
            return
        dump(str(temporary))
        os.chmod(temporary, 0o600)
        temporary.replace(INSTAGRAPI_SETTINGS_PATH)
        os.chmod(INSTAGRAPI_SETTINGS_PATH, 0o600)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass


def _get_instagrapi_client():
    with _INSTAGRAPI_LOCK:
        if _INSTAGRAPI_STATE["client"] is not None:
            return _INSTAGRAPI_STATE["client"]
        if float(_INSTAGRAPI_STATE["retry_after"]) > time.monotonic():
            return None
        client = None
        try:
            client, mode = _build_instagrapi_client()
            if client is None:
                _INSTAGRAPI_STATE.update(client=None, mode="disabled", retry_after=0.0)
                return None
            _INSTAGRAPI_STATE.update(client=client, mode=mode, retry_after=0.0)
            _persist_instagrapi_settings(client)
            return client
        except Exception as error:
            kind = _instagrapi_error_kind(error)
            cooldown = (
                INSTAGRAPI_RATE_COOLDOWN_SECONDS
                if kind == "rate-limited"
                else INSTAGRAPI_AUTH_COOLDOWN_SECONDS
                if kind in {"expired-session", "challenge-required"}
                else 60
            )
            _close_instagrapi_client(client)
            _INSTAGRAPI_STATE.update(
                client=None,
                mode=kind,
                retry_after=time.monotonic() + cooldown,
            )
            if kind == "rate-limited":
                raise HTTPException(
                    status_code=503,
                    headers={"Retry-After": str(cooldown)},
                    detail={
                        "code": "INSTAGRAPI_RATE_LIMITED",
                        "error": "Instagram temporarily limited the authenticated media request.",
                    },
                )
            return None


def _invalidate_instagrapi_client(
    client: object | None,
    mode: str = "expired-session",
    cooldown: int = INSTAGRAPI_AUTH_COOLDOWN_SECONDS,
) -> None:
    with _INSTAGRAPI_LOCK:
        active = _INSTAGRAPI_STATE["client"]
        if client is None or active is client:
            _close_instagrapi_client(active)
            _INSTAGRAPI_STATE.update(
                client=None,
                mode=mode,
                retry_after=time.monotonic() + max(1, cooldown),
            )


def _refresh_instagrapi_client(client: object | None):
    """Try one credential-backed renewal, guarded against concurrent login loops."""
    auto_reauth = os.environ.get("INSTAGRAPI_AUTO_REAUTH", "").strip().lower() in {"1", "true", "yes", "on"}
    username = os.environ.get("INSTAGRAPI_USERNAME", "").strip()
    password = os.environ.get("INSTAGRAPI_PASSWORD", "")
    if not auto_reauth or not username or not password:
        _invalidate_instagrapi_client(client, "expired-session")
        return None

    with _INSTAGRAPI_LOCK:
        if client is not None and _INSTAGRAPI_STATE["client"] is not client:
            return _INSTAGRAPI_STATE["client"]
        if float(_INSTAGRAPI_STATE["reauth_retry_after"]) > time.monotonic():
            _invalidate_instagrapi_client(client, "reauth-cooldown")
            return None

        _INSTAGRAPI_STATE["reauth_retry_after"] = (
            time.monotonic() + INSTAGRAPI_AUTH_COOLDOWN_SECONDS
        )
        active = _INSTAGRAPI_STATE["client"]
        _close_instagrapi_client(active)
        _INSTAGRAPI_STATE.update(client=None, mode="renewing", retry_after=0.0)

        renewed = None
        try:
            renewed, mode = _build_instagrapi_client(require_renewal=True)
            if renewed is None:
                raise RuntimeError("Instagrapi renewal is not configured")
            _INSTAGRAPI_STATE.update(
                client=renewed,
                mode=mode,
                retry_after=0.0,
                reauth_retry_after=0.0,
            )
            _persist_instagrapi_settings(renewed)
            return renewed
        except Exception as error:
            kind = _instagrapi_error_kind(error)
            _close_instagrapi_client(renewed)
            cooldown = (
                INSTAGRAPI_RATE_COOLDOWN_SECONDS
                if kind == "rate-limited"
                else INSTAGRAPI_AUTH_COOLDOWN_SECONDS
            )
            _INSTAGRAPI_STATE.update(
                client=None,
                mode="reauth-" + kind,
                retry_after=time.monotonic() + cooldown,
            )
            if kind == "rate-limited":
                raise HTTPException(
                    status_code=503,
                    headers={"Retry-After": str(cooldown)},
                    detail={
                        "code": "INSTAGRAPI_RATE_LIMITED",
                        "error": "Instagram temporarily limited the authenticated media request.",
                    },
                )
            return None


def _media_value(media: object, key: str, default=None):
    if isinstance(media, dict):
        return media.get(key, default)
    return getattr(media, key, default)


def _media_mapping(media: object) -> dict:
    if isinstance(media, dict):
        return media
    for method_name in ("model_dump", "dict"):
        method = getattr(media, method_name, None)
        if callable(method):
            try:
                result = method()
                if isinstance(result, dict):
                    return result
            except Exception:
                pass
    result = {}
    for key in (
        "image_versions2", "thumbnail_resources", "thumbnail_url", "display_url",
        "thumbnail_src", "caption_text", "title", "user", "owner",
    ):
        value = getattr(media, key, None)
        if value is not None:
            if key in {"user", "owner"} and not isinstance(value, dict):
                value = {
                    "username": getattr(value, "username", ""),
                    "full_name": getattr(value, "full_name", ""),
                    "is_private": getattr(value, "is_private", False),
                }
            result[key] = value
    return result


def _media_video_urls(media: object) -> list[str]:
    """Return at most three host-validated CDN video URL candidates."""
    found: list[tuple[int, int, str]] = []
    seen: set[str] = set()

    def add(raw_url, width=0, height=0, priority=0):
        if not isinstance(raw_url, str):
            return
        safe_url = allowed_instagram_media_url(raw_url)
        if not safe_url or safe_url in seen:
            return
        seen.add(safe_url)
        try:
            score = int(width or 0) * int(height or 0)
        except (TypeError, ValueError):
            score = 0
        found.append((priority, score, safe_url))

    add(_media_value(media, "video_url"), priority=2)
    versions = _media_value(media, "video_versions") or []
    if isinstance(versions, dict):
        versions = versions.get("candidates") or versions.get("versions") or []
    if isinstance(versions, (list, tuple)):
        for version in versions:
            add(
                _media_value(version, "url") or _media_value(version, "video_url"),
                _media_value(version, "width", 0),
                _media_value(version, "height", 0),
                priority=1,
            )
    resources = _media_value(media, "resources") or []
    if isinstance(resources, (list, tuple)):
        for resource in resources:
            add(
                _media_value(resource, "video_url") or _media_value(resource, "url"),
                _media_value(resource, "width", 0),
                _media_value(resource, "height", 0),
                priority=0,
            )
    found.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in found[:3]]


def _download_instagrapi_cdn_video(media_url: str, source_file: Path) -> str:
    """Download via a separate anonymous transport; never forward private API cookies."""
    response = None
    try:
        media_url = allowed_instagram_media_url(media_url)
        if not media_url:
            return "unavailable"
        response = curl_requests.get(
            media_url,
            impersonate="chrome",
            stream=True,
            timeout=22,
        )
        if response.status_code == 429:
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": str(INSTAGRAPI_RATE_COOLDOWN_SECONDS)},
                detail={
                    "code": "INSTAGRAPI_RATE_LIMITED",
                    "error": "Instagram temporarily limited the authenticated media request.",
                },
            )
        if response.status_code in (401, 403):
            source_file.unlink(missing_ok=True)
            return "stale-cdn-url"
        final_url = allowed_instagram_media_url(str(getattr(response, "url", media_url)))
        if not response.ok or not final_url:
            return "unavailable"
        content_type = str(response.headers.get("content-type", "")).split(";", 1)[0].strip().lower()
        if content_type.startswith("text/") or "application/json" in content_type:
            return "unavailable"
        try:
            declared_size = int(response.headers.get("content-length", "0"))
        except (TypeError, ValueError):
            declared_size = 0
        if declared_size > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})

        received = 0
        with source_file.open("wb") as output:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                received += len(chunk)
                if received > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})
                output.write(chunk)
        if received < 128:
            source_file.unlink(missing_ok=True)
            return "unavailable"
        return "ok"
    except HTTPException:
        source_file.unlink(missing_ok=True)
        raise
    except Exception:
        source_file.unlink(missing_ok=True)
        return "unavailable"
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _read_media_details(client: object, shortcode: str):
    """Serialize authenticated API access when using a shared worker client."""
    with _INSTAGRAPI_LOCK:
        media_pk = int(client.media_pk_from_code(shortcode))
        media = client.media_info(media_pk)
        if media is None:
            media = client.media_info_v1(media_pk)
        return media_pk, media


def try_instagrapi_public_media(
    source_url: str,
    shortcode: str,
    directory: Path,
    quality: str,
) -> dict | None:
    """Fetch public video with a reused session and bounded signed-URL refresh."""
    if not instagrapi_is_configured() or not shortcode:
        return None

    client = None
    try:
        client = _get_instagrapi_client()
        if client is None:
            return None

        try:
            media_pk, media = _read_media_details(client, shortcode)
        except Exception as first_error:
            kind = _instagrapi_error_kind(first_error)
            if kind == "rate-limited":
                _invalidate_instagrapi_client(
                    client, "rate-limited", INSTAGRAPI_RATE_COOLDOWN_SECONDS
                )
                raise HTTPException(
                    status_code=503,
                    headers={"Retry-After": str(INSTAGRAPI_RATE_COOLDOWN_SECONDS)},
                    detail={
                        "code": "INSTAGRAPI_RATE_LIMITED",
                        "error": "Instagram temporarily limited the authenticated media request.",
                    },
                )
            if kind == "expired-session":
                client = _refresh_instagrapi_client(client)
                if client is None:
                    return None
                try:
                    media_pk, media = _read_media_details(client, shortcode)
                except Exception as retry_error:
                    retry_kind = _instagrapi_error_kind(retry_error)
                    if retry_kind == "rate-limited":
                        _invalidate_instagrapi_client(
                            client, "rate-limited", INSTAGRAPI_RATE_COOLDOWN_SECONDS
                        )
                        raise HTTPException(
                            status_code=503,
                            headers={"Retry-After": str(INSTAGRAPI_RATE_COOLDOWN_SECONDS)},
                            detail={
                                "code": "INSTAGRAPI_RATE_LIMITED",
                                "error": "Instagram temporarily limited the authenticated media request.",
                            },
                        )
                    if retry_kind in {"expired-session", "challenge-required"}:
                        _invalidate_instagrapi_client(client, retry_kind)
                    return None
            elif kind == "challenge-required":
                _invalidate_instagrapi_client(client, "challenge-required")
                return None
            else:
                return None

        owner = _media_value(media, "user") or _media_value(media, "owner")
        if bool(_media_value(owner, "is_private", False)):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "PRIVATE_REEL",
                    "error": "This converter only processes public Instagram media.",
                },
            )

        video_urls = _media_video_urls(media)
        media_type = str(_media_value(media, "media_type", "") or "")
        if media_type not in {"2", "video"} and not video_urls:
            return None
        if not video_urls:
            with _INSTAGRAPI_LOCK:
                media = client.media_info_v1(media_pk)
            video_urls = _media_video_urls(media)
        if not video_urls:
            return None

        duration_value = _media_value(media, "video_duration")
        try:
            duration = float(duration_value) if duration_value is not None else 0.0
        except (TypeError, ValueError):
            duration = 0.0
        if duration > MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "VIDEO_TOO_LONG",
                    "error": "This Reel exceeds the 20-minute conversion limit.",
                },
            )

        source_file = directory / "instagrapi-source.bin"
        audio_file = directory / "instagrapi-audio.mp3"
        old_urls: set[str] = set()
        saw_stale_cdn_url = False
        download_status = "unavailable"
        for candidate in video_urls[:2]:
            old_urls.add(candidate)
            download_status = _download_instagrapi_cdn_video(candidate, source_file)
            saw_stale_cdn_url = saw_stale_cdn_url or download_status == "stale-cdn-url"
            if download_status == "ok":
                break

        if download_status != "ok" and saw_stale_cdn_url:
            # A signed CDN URL may expire independently of the account session.
            # Refresh API metadata exactly once and try only one newly signed URL.
            try:
                with _INSTAGRAPI_LOCK:
                    fresh_media = client.media_info_v1(media_pk)
            except HTTPException:
                raise
            except Exception as refresh_error:
                refresh_kind = _instagrapi_error_kind(refresh_error)
                if refresh_kind == "rate-limited":
                    _invalidate_instagrapi_client(
                        client, "rate-limited", INSTAGRAPI_RATE_COOLDOWN_SECONDS
                    )
                    raise HTTPException(
                        status_code=503,
                        headers={"Retry-After": str(INSTAGRAPI_RATE_COOLDOWN_SECONDS)},
                        detail={
                            "code": "INSTAGRAPI_RATE_LIMITED",
                            "error": "Instagram temporarily limited the authenticated media request.",
                        },
                    )
                if refresh_kind == "expired-session":
                    client = _refresh_instagrapi_client(client)
                    if client is None:
                        return None
                    try:
                        with _INSTAGRAPI_LOCK:
                            fresh_media = client.media_info_v1(media_pk)
                    except Exception:
                        return None
                else:
                    return None

            fresh_urls = _media_video_urls(fresh_media)
            fresh_url = next((url for url in fresh_urls if url not in old_urls), None)
            if fresh_url:
                refreshed_status = _download_instagrapi_cdn_video(fresh_url, source_file)
                if refreshed_status == "ok":
                    media = fresh_media
                    download_status = "ok"

        if download_status != "ok":
            return None

        ffprobe = shutil.which("ffprobe")
        ffmpeg = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
        if not ffprobe:
            return None
        probe = subprocess.run(
            [
                ffprobe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(source_file),
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        try:
            probed_duration = float((probe.stdout or "").strip())
        except (TypeError, ValueError):
            probed_duration = 0.0
        if probe.returncode != 0 or probed_duration <= 0:
            return None
        if probed_duration > MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "VIDEO_TOO_LONG",
                    "error": "This Reel exceeds the 20-minute conversion limit.",
                },
            )

        raw_caption = _media_value(media, "caption_text") or ""
        if not raw_caption:
            caption = _media_value(media, "caption")
            raw_caption = caption.get("text", "") if isinstance(caption, dict) else caption or ""
        title = clean_metadata(raw_caption or ("Instagram Reel " + shortcode), 160)
        artist = clean_metadata(_media_value(owner, "username") or "", 80)
        _persist_instagrapi_settings(client)

        cover_path = None
        cover_session = None
        media_payload = _media_mapping(media)
        try:
            if media_payload:
                cover_session = curl_requests.Session(
                    impersonate="chrome",
                    headers={
                        "Referer": "https://www.instagram.com/",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                )
                cover_path = download_public_thumbnail(cover_session, media_payload, directory)
        except Exception:
            cover_path = None
        finally:
            if cover_session is not None:
                try:
                    cover_session.close()
                except Exception:
                    pass

        args = [
            ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-i", str(source_file),
        ]
        if cover_path is not None:
            args.extend(["-i", str(cover_path)])
        args.extend([
            "-map", "0:a:0?",
            "-codec:a", "libmp3lame",
            "-b:a", f"{quality}k",
            "-map_metadata", "-1",
            "-metadata", "title=" + title,
            "-metadata", "album=Instagram Reels",
            "-metadata", "comment=Converted with ReelTone",
            "-id3v2_version", "3",
        ])
        if artist:
            args.extend(["-metadata", "artist=" + artist])
        if cover_path is not None:
            args.extend([
                "-map", "1:v:0",
                "-codec:v", "mjpeg",
                "-disposition:v:0", "attached_pic",
            ])
        else:
            args.append("-vn")
        args.extend(["-f", "mp3", str(audio_file)])

        encoded = subprocess.run(
            args,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if encoded.returncode != 0:
            audio_file.unlink(missing_ok=True)
            args_no_cover = [
                ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-i", str(source_file), "-vn", "-map", "0:a:0?",
                "-codec:a", "libmp3lame", "-b:a", f"{quality}k",
                "-map_metadata", "-1",
                "-metadata", "title=" + title,
                "-metadata", "album=Instagram Reels",
                "-metadata", "comment=Converted with ReelTone",
                "-id3v2_version", "3",
            ]
            if artist:
                args_no_cover.extend(["-metadata", "artist=" + artist])
            args_no_cover.extend(["-f", "mp3", str(audio_file)])
            encoded = subprocess.run(
                args_no_cover,
                capture_output=True,
                timeout=60,
                check=False,
            )

        if (
            encoded.returncode != 0
            or not audio_file.exists()
            or audio_file.stat().st_size < 128
        ):
            audio_file.unlink(missing_ok=True)
            return None

        _persist_instagrapi_settings(client)
        return {
            "title": title,
            "uploader": artist,
            "_extractor": "instagrapi",
        }
    except HTTPException as error:
        details = error.detail if isinstance(error.detail, dict) else {}
        if details.get("code") == "INSTAGRAPI_RATE_LIMITED":
            _invalidate_instagrapi_client(
                client, "rate-limited", INSTAGRAPI_RATE_COOLDOWN_SECONDS
            )
        raise
    except Exception as error:
        kind = _instagrapi_error_kind(error)
        if kind == "rate-limited":
            _invalidate_instagrapi_client(
                client, "rate-limited", INSTAGRAPI_RATE_COOLDOWN_SECONDS
            )
            raise HTTPException(
                status_code=503,
                headers={"Retry-After": str(INSTAGRAPI_RATE_COOLDOWN_SECONDS)},
                detail={
                    "code": "INSTAGRAPI_RATE_LIMITED",
                    "error": "Instagram temporarily limited the authenticated media request.",
                },
            )
        if kind in {"expired-session", "challenge-required"}:
            _invalidate_instagrapi_client(client, kind)
        # Do not expose exception messages; they may contain cookies or signed URLs.
        return None


def try_gallery_dl_public_media(
    source_url: str,
    shortcode: str,
    directory: Path,
    quality: str,
) -> dict | None:
    """Best-effort independent anonymous extractor, bounded and rate-limit aware."""
    executable = shutil.which("gallery-dl")
    if not executable:
        return None

    output_dir = directory / "gallery-dl"
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_file = directory / "gallery-dl-audio.mp3"
    args = [
        executable,
        "--config-ignore",
        "--no-mtime",
        "--http-timeout", "6",
        "--retries", "0",
        "--sleep-request", "1",
        "--filesize-max", "150M",
        "--filter", "extension in ('mp4', 'm4v', 'mov', 'webm', 'mkv', 'm4a', 'mp3', 'ogg', 'opus', 'aac')",
        "--directory", str(output_dir),
        "--filename", "{id}_{num}.{extension}",
        source_url,
    ]

    try:
        result = subprocess.run(
            args,
            cwd=str(directory),
            env={**os.environ, "HOME": str(directory), "TMPDIR": str(directory)},
            capture_output=True,
            text=True,
            errors="replace",
            timeout=18,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None

    diagnostic = (result.stderr or "") + "\n" + (result.stdout or "")
    if re.search(r"(?:\b429\b|too many requests|rate.?limit)", diagnostic, re.IGNORECASE):
        raise HTTPException(
            status_code=503,
            headers={"Retry-After": "30"},
            detail={"code": "GALLERY_DL_RATE_LIMITED", "error": "The independent Instagram gallery extractor was rate-limited."},
        )

    supported = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".m4a", ".mp3", ".ogg", ".opus", ".aac"}
    candidates = sorted(
        (
            item for item in output_dir.rglob("*")
            if item.is_file() and item.suffix.lower() in supported and item.stat().st_size >= 128
        ),
        key=lambda item: item.stat().st_size,
        reverse=True,
    )
    if not candidates:
        return None

    media_file = candidates[0]
    size = media_file.stat().st_size
    if size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})

    ffprobe = shutil.which("ffprobe")
    ffmpeg = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
    if not ffprobe:
        return None

    try:
        duration_result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(media_file)],
            capture_output=True, text=True, timeout=8, check=False,
        )
        duration = float((duration_result.stdout or "").strip())
        if duration <= 0:
            return None
        if duration > MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=413,
                detail={"code": "VIDEO_TOO_LONG", "error": "This Reel exceeds the 20-minute conversion limit."},
            )

        audio_probe = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(media_file)],
            capture_output=True, text=True, timeout=8, check=False,
        )
        if "audio" not in (audio_probe.stdout or "").lower():
            return None

        title = clean_metadata("Instagram Reel " + shortcode, 160)
        audio_file.unlink(missing_ok=True)
        encoded = subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(media_file), "-vn", "-map", "0:a:0",
                "-codec:a", "libmp3lame", "-b:a", f"{quality}k",
                "-map_metadata", "-1",
                "-metadata", "title=" + title,
                "-metadata", "album=Instagram Reels",
                "-metadata", "comment=Converted with ReelTone",
                "-id3v2_version", "3",
                "-f", "mp3", str(audio_file),
            ],
            capture_output=True, timeout=60, check=False,
        )
        if encoded.returncode != 0 or not audio_file.exists() or audio_file.stat().st_size < 128:
            audio_file.unlink(missing_ok=True)
            return None

        return {"title": title, "uploader": "", "_extractor": "gallery-dl"}
    except HTTPException:
        raise
    except Exception:
        audio_file.unlink(missing_ok=True)
        return None


@app.post("/convert")
def convert(
    payload: ConvertRequest,
    authorization: str | None = Header(default=None),
):
    require_service_token(authorization)
    source_url = canonical_public_instagram_url(payload.url)

    if not ACTIVE_JOBS.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            headers={"Retry-After": "5"},
            detail={"code": "EXTRACTOR_BUSY"},
        )

    directory = Path(tempfile.mkdtemp(prefix="reeltone-ig-"))
    cleanup = make_cleanup(directory)
    keep_for_response = False

    try:
        parsed_source = urlparse(source_url)
        shortcode_match = re.search(r"/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", parsed_source.path)
        shortcode = shortcode_match.group(1) if shortcode_match else ""
        info = None
        final_failure: tuple[int, str, str] | None = None

        if payload.strategy == "gallery-dl-only":
            # Make exactly one gallery-dl request when the service-level cooldown permits it.
            if shortcode:
                info = try_gallery_dl_public_media(source_url, shortcode, directory, payload.quality)
            if info is None:
                raise HTTPException(
                    status_code=503,
                    detail={"code": "NO_PUBLIC_MEDIA", "error": "The independent public-media extractor returned no playable file."},
                )
        elif payload.strategy in ("instagrapi-only", "rate-limit-fallback"):
            # Use the authenticated mobile API once during an active source cooldown.
            if shortcode:
                info = try_instagrapi_public_media(source_url, shortcode, directory, payload.quality)
            if info is None and payload.strategy == "rate-limit-fallback" and shortcode:
                info = try_gallery_dl_public_media(source_url, shortcode, directory, payload.quality)
            if info is None:
                code = (
                    "INSTAGRAPI_NOT_CONFIGURED"
                    if payload.strategy == "instagrapi-only" and not instagrapi_is_configured()
                    else "NO_PUBLIC_MEDIA"
                )
                raise HTTPException(
                    status_code=503,
                    detail={"code": code, "error": "No playable public media was returned by the configured fallback."},
                )
        else:
            # Prefer the authenticated mobile API when configured. If it has no
            # media, retain the anonymous GraphQL and gallery-dl path.
            if shortcode and instagrapi_is_configured():
                info = try_instagrapi_public_media(source_url, shortcode, directory, payload.quality)
            if info is None and shortcode:
                try:
                    info = try_graphql_public_media(source_url, shortcode, directory, payload.quality)
                except HTTPException as graph_error:
                    detail = graph_error.detail if isinstance(graph_error.detail, dict) else {}
                    if detail.get("code") != "SOURCE_RATE_LIMITED":
                        raise
                    info = try_gallery_dl_public_media(source_url, shortcode, directory, payload.quality)
                    if info is None:
                        raise graph_error
            if info is None and shortcode:
                info = try_gallery_dl_public_media(source_url, shortcode, directory, payload.quality)

        # Extractor success writes an MP3 into the request workspace.
        # Otherwise, use two separate
        # impersonated fingerprints with bounded retries and no cookies.
        if info is None and payload.strategy == "auto":
            final_failure = None
            for profile in ("chrome", "safari"):
                output_template = str(directory / (profile + "-audio.%(ext)s"))
                options = {
                    "format": "best[acodec!=none]/best",
                    "outtmpl": output_template,
                    "noplaylist": True,
                    "quiet": True,
                    "no_warnings": True,
                    "ignoreerrors": False,
                    "socket_timeout": 20,
                    "retries": 2,
                    "fragment_retries": 2,
                    "max_filesize": MAX_FILE_BYTES,
                    "match_filter": f"duration <= {MAX_DURATION_SECONDS}",
                    "extractaudio": True,
                    "audioformat": "mp3",
                    "audioquality": f"{payload.quality}K",
                    # Reuse yt-dlp's mature postprocessors for metadata and ID3 cover art.
                    "addmetadata": True,
                    "writethumbnail": True,
                    "embedthumbnail": True,
                    "ffmpeg_location": shutil.which("ffmpeg") or "/usr/bin/ffmpeg",
                    "impersonate": profile,
                    "http_headers": {
                        "Referer": "https://www.instagram.com/",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    "overwrites": True,
                }

                try:
                    with yt_dlp.YoutubeDL(options) as downloader:
                        info = downloader.extract_info(source_url, download=True)
                    final_failure = None
                    break
                except DownloadError as error:
                    final_failure = safe_download_error(error)
                    _status, code, _message = final_failure
                    if code in {"SOURCE_RATE_LIMITED", "LOGIN_REQUIRED", "REEL_UNAVAILABLE", "VIDEO_TOO_LONG"}:
                        break
                    # Retry once with a distinct supported browser fingerprint.
                    continue
                except Exception as error:
                    # yt-dlp raises ExtractorError for some Instagram empty-media
                    # responses rather than DownloadError. Classify that exception
                    # too, then allow the alternate fingerprint unless the result
                    # is a definitive login/removal/rate-limit/duration response.
                    final_failure = safe_download_error(error)
                    _status, code, _message = final_failure
                    if code in {"SOURCE_RATE_LIMITED", "LOGIN_REQUIRED", "REEL_UNAVAILABLE", "VIDEO_TOO_LONG"}:
                        break
                    continue

            if final_failure is not None:
                status, code, message = final_failure
                raise HTTPException(status_code=status, detail={"code": code, "error": message})

        audio_candidates = [
            item for item in directory.iterdir()
            if item.is_file() and item.suffix.lower() == ".mp3"
        ]
        if not audio_candidates:
            raise HTTPException(
                status_code=503,
                detail={"code": "EXTRACTOR_EMPTY", "error": "The extractor did not generate MP3 audio."},
            )
        audio_file = max(audio_candidates, key=lambda item: item.stat().st_size)
        size = audio_file.stat().st_size
        if size < 128:
            raise HTTPException(status_code=503, detail={"code": "EXTRACTOR_EMPTY"})
        if size > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail={"code": "VIDEO_TOO_LARGE"})

        title = clean_metadata(info.get("title") if isinstance(info, dict) else "", 160)
        author = clean_metadata(
            (info.get("uploader") or info.get("channel") or info.get("uploader_id"))
            if isinstance(info, dict) else "",
            80,
        )
        headers = {
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "X-ReelTone-Title": quote(title, safe=""),
            "X-ReelTone-Author": quote(author, safe=""),
            "Content-Length": str(size),
        }

        response = FileResponse(
            path=audio_file,
            media_type="audio/mpeg",
            filename="reeltone.mp3",
            headers=headers,
            background=BackgroundTask(cleanup),
        )
        keep_for_response = True
        return response
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={"code": "EXTRACTOR_UNAVAILABLE", "error": "The extractor could not complete this public Reel."},
        )
    finally:
        if not keep_for_response:
            cleanup()
