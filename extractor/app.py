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
MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024
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
    return {
        "ok": True,
        "service": "reeltone-impersonated-extractor",
        "engine": "yt-dlp",
        "browserImpersonation": True,
        "ffmpegAvailable": shutil.which("ffmpeg") is not None,
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

        # First try Instagram's anonymous public GraphQL media query. It may
        # return CDN video URLs even when a logged-out page redirects to login.
        # If the query is stale or errors, continue to yt-dlp's own extractor.
        if shortcode:
            info = try_graphql_public_media(source_url, shortcode, directory, payload.quality)

        # GraphQL success writes graphql-audio.mp3. Otherwise, use two separate
        # impersonated fingerprints with bounded retries and no cookies.
        if info is None:
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
