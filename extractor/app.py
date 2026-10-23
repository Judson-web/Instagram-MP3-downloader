from __future__ import annotations

import hmac
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
        output_template = str(directory / "audio.%(ext)s")
        options = {
            "format": "best[acodec!=none]/best",
            "outtmpl": output_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "ignoreerrors": False,
            "socket_timeout": 20,
            "retries": 1,
            "fragment_retries": 1,
            "max_filesize": MAX_FILE_BYTES,
            "match_filter": f"duration <= {MAX_DURATION_SECONDS}",
            "extractaudio": True,
            "audioformat": "mp3",
            "audioquality": f"{payload.quality}K",
            "ffmpeg_location": shutil.which("ffmpeg") or "/usr/bin/ffmpeg",
            # Instagram may reject a generic server TLS fingerprint even when a
            # Reel is public. Use yt-dlp's supported curl-cffi impersonation path.
            # No login cookies, account session, or supplied headers are accepted.
            "impersonate": "chrome",
            "http_headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/129.0.0.0 Safari/537.36"
                ),
                "Referer": "https://www.instagram.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
            "overwrites": True,
        }

        try:
            with yt_dlp.YoutubeDL(options) as downloader:
                info = downloader.extract_info(source_url, download=True)
        except DownloadError as error:
            status, code, message = safe_download_error(error)
            raise HTTPException(status_code=status, detail={"code": code, "error": message})
        except Exception:
            raise HTTPException(
                status_code=503,
                detail={"code": "EXTRACTOR_UNAVAILABLE", "error": "The extractor could not finish the request."},
            )

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
