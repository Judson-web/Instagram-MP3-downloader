from __future__ import annotations

import hmac
import json
import subprocess
import os
import re
import shutil
import tempfile
import threading
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
ALLOWED_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
POST_PATH = re.compile(r"^/(?:reel|reels|p|tv)/[A-Za-z0-9_-]+/?$", re.IGNORECASE)
QUALITY_PRESETS = {"128", "192", "256", "320"}
ACTIVE_JOBS = threading.BoundedSemaphore(value=2)

app = FastAPI(
    title="ReelTone Impersonated Extractor",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class ConvertRequest(BaseModel):
    url: str = Field(min_length=12, max_length=2048)
    quality: Literal["128", "192", "256", "320"] = "192"


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

        ffmpeg = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", str(source_file),
                "-vn",
                "-map", "0:a:0",
                "-codec:a", "libmp3lame",
                "-b:a", f"{quality}k",
                "-map_metadata", "-1",
                str(audio_file),
            ],
            capture_output=True,
            check=False,
            timeout=60,
        )
        source_file.unlink(missing_ok=True)
        if result.returncode != 0 or not audio_file.exists() or audio_file.stat().st_size < 128:
            audio_file.unlink(missing_ok=True)
            return None

        user = item.get("user") or item.get("owner") or {}
        caption = item.get("caption")
        if isinstance(caption, dict):
            caption = caption.get("text")
        return {
            "title": clean_metadata(item.get("title") or caption, 160),
            "uploader": clean_metadata(
                user.get("full_name") or user.get("username") or "",
                80,
            ),
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
    return {
        "ok": True,
        "service": "reeltone-impersonated-extractor",
        "engine": "yt-dlp",
        "browserImpersonation": True,
        "ffmpegAvailable": shutil.which("ffmpeg") is not None,
    }


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
        last_download_error: Exception | None = None
        final_failure: tuple[int, str, str] | None = None

        # First try Instagram's anonymous public GraphQL media query. This can
        # return CDN video metadata even when the individual HTML page redirects
        # logged-out visitors to the login screen. If the query is stale or fails,
        # continue to the upstream yt-dlp extractor below.
        if shortcode:
            info = try_graphql_public_media(source_url, shortcode, directory, payload.quality)

        # A successful direct GraphQL extraction writes graphql-audio.mp3.
        # In that case skip both browser-fingerprint download attempts.
        if info is None:
            # The impersonated TLS/browser profile must own its matching User-Agent.
        # Manually overriding it with an older Chrome version can undo the benefit
        # of curl-cffi impersonation. Try one alternate profile on generic/empty
        # media failures, but stop immediately for login walls, removed posts,
        # duration limits, or explicit upstream rate limits.
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
                    last_download_error = None
                    final_failure = None
                    break
                except DownloadError as error:
                    last_download_error = error
                    final_failure = safe_download_error(error)
                    status, code, message = final_failure
                    if code in {"SOURCE_RATE_LIMITED", "LOGIN_REQUIRED", "REEL_UNAVAILABLE", "VIDEO_TOO_LONG"}:
                        break
                    # Retry only once, with a distinct supported browser fingerprint.
                    continue
                except Exception as error:
                    last_download_error = error
                    final_failure = (503, "EXTRACTOR_UNAVAILABLE", "The extractor could not finish the request.")
                    if profile == "chrome":
                        continue
                    break
    
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
