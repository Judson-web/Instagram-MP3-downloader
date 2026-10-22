"use strict";

import express = require("express");
import helmet from "helmet";
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import crypto = require("node:crypto");
import net = require("node:net");
import type { ChildProcess } from "node:child_process";
import { maskClientIp } from "./ip-anonymization";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";

const youtubeDl: any = require("youtube-dl-exec");
const ffmpegPath: string | null = require("ffmpeg-static") as string | null;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_DURATION_SECONDS = 20 * 60;
const MAX_REQUESTS_PER_HOUR = 8;
const PROCESS_TIMEOUT_MS = 50 * 1000;
const QUALITY_PRESETS = new Set(["128", "192", "256", "320"]);
const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com"
]);
const regularPostPath = /^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i;
const sharedPostPath = /^\/share\/reel\/([A-Za-z0-9_-]+)\/?$/i;
const requestsByIp = new Map<string, number[]>();
let localRequestCounter = 0;
let sqlClient: ReturnType<typeof neon> | null = null;

type ApiErrorCode =
  | "INVALID_URL" | "INVALID_QUALITY" | "RATE_LIMITED" | "DATABASE_UNAVAILABLE"
  | "ENGINE_UNAVAILABLE" | "PRIVATE_REEL" | "LOGIN_REQUIRED" | "INSTAGRAM_RATE_LIMITED" | "RESOLVER_RATE_LIMITED" | "PROVIDER_RATE_LIMITED"
  | "REEL_UNAVAILABLE" | "NO_PUBLIC_MEDIA" | "VIDEO_TOO_LONG" | "VIDEO_TOO_LARGE"
  | "CONVERSION_TIMEOUT" | "RESOLVER_UNAVAILABLE" | "CONVERSION_FAILED";

interface ApiErrorPayload {
  code: ApiErrorCode;
  title: string;
  error: string;
  retryable: boolean;
  category: "input" | "privacy" | "availability" | "rate-limit" | "service" | "conversion";
  retryAfterSeconds?: number;
}
type QualityPreset = "128" | "192" | "256" | "320";
type ProcessSetter = (process: ChildProcess | null) => void;
interface VideoVersion { url: string; width: number; height: number; }
interface ValidatedInstagramUrl { ok: true; url: string; }
interface InvalidInstagramUrl { ok: false; reason: string; }
interface ResolverMediaItem { type?: string; url?: string; duration?: number | string; }
interface PublicResolverPayload {
  ok?: boolean; platform?: string; code?: string; error?: string; message?: string;
  title?: string; author?: string; duration?: number | string; media?: ResolverMediaItem[];
  private?: boolean; is_private?: boolean; login_required?: boolean; requires_login?: boolean;
}
interface ConversionAttempt {
  ok: boolean;
  reason: string;
  detail?: string;
  diagnostic?: string;
  retryAfterSeconds?: number;
  title?: string;
  author?: string;
}
type MediaAssetAttempt =
  | { ok: true; response: globalThis.Response; url: string; contentLength: number }
  | { ok: false; reason: string; retryAfterSeconds?: number };

function sendApiError(res: Response, status: number, payload: ApiErrorPayload): Response {
  res.set("Cache-Control", "no-store");
  if (payload.retryAfterSeconds !== undefined) {
    res.set("Retry-After", String(Math.max(1, Math.ceil(payload.retryAfterSeconds))));
  }
  return res.status(status).json(payload);
}

function classifyConversionFailure(evidence: string, timedOut = false): { status: number; payload: ApiErrorPayload } {
  const message = String(evidence || "").toLowerCase();
  if (timedOut || /(?:timeout|timed out|process.*(?:killed|timeout))/.test(message)) {
    return { status: 504, payload: { code: "CONVERSION_TIMEOUT", title: "That conversion took too long", error: "Instagram or the media source did not respond in time. Try again later, or try a different public Reel.", retryable: true, category: "conversion" } };
  }
  if (/(?:^|[\\s:_-])private(?:$|[\\s,.:_-])|private account|private reel|only the owner|media is private|is_private/.test(message)) {
    return { status: 422, payload: { code: "PRIVATE_REEL", title: "This Reel appears to be private", error: "Instagram or the resolver explicitly marked this media as private. ReelTone only processes media available publicly without signing in.", retryable: false, category: "privacy" } };
  }
  if (/(?:login[-_ ]required|redirected to the login page|sign in to (?:view|continue)|log in to (?:view|continue)|authentication required|requires? (?:you to )?(?:log in|sign in))/.test(message)) {
    return { status: 422, payload: { code: "LOGIN_REQUIRED", title: "Instagram requires a signed-in session", error: "This link is gated behind Instagram login or an age/visibility check. ReelTone does not use account cookies or ask for your password, so this Reel cannot be processed here.", retryable: false, category: "privacy" } };
  }
  if (/resolver-rate-limited|resolver-cooldown/.test(message)) {
    return { status: 503, payload: { code: "RESOLVER_RATE_LIMITED", title: "The link lookup service is cooling down", error: "The lookup provider is temporarily limiting requests. ReelTone will pause calls to it instead of repeatedly retrying.", retryable: true, category: "rate-limit", retryAfterSeconds: DEFAULT_SOURCE_COOLDOWN_SECONDS } };
  }
  if (/provider-rate-limited|provider-cooldown/.test(message)) {
    return { status: 503, payload: { code: "PROVIDER_RATE_LIMITED", title: "The media provider is cooling down", error: "The media provider is temporarily limiting requests. ReelTone will pause calls to it instead of repeatedly retrying.", retryable: true, category: "rate-limit", retryAfterSeconds: DEFAULT_SOURCE_COOLDOWN_SECONDS } };
  }
  if (/(?:exceeded the rate.?limit|too many requests|rate.?limit|http error 429|status.?429|instagram-rate-limited)/.test(message)) {
    return { status: 503, payload: { code: "INSTAGRAM_RATE_LIMITED", title: "Instagram is temporarily limiting requests", error: "ReelTone has paused further Instagram requests to respect the source limit.", retryable: true, category: "rate-limit", retryAfterSeconds: DEFAULT_SOURCE_COOLDOWN_SECONDS } };
  }
  if (/duration-limit|video too long|longer than the 20-minute limit|duration.{0,40}(?:exceeds?|greater than|longer than)/.test(message)) {
    return { status: 413, payload: { code: "VIDEO_TOO_LONG", title: "This Reel is longer than the limit", error: "ReelTone supports videos up to 20 minutes per conversion.", retryable: false, category: "availability" } };
  }
  if (/media-too-large|source video exceeded the size limit|video file is too large/.test(message)) {
    return { status: 413, payload: { code: "VIDEO_TOO_LARGE", title: "This video is too large to process", error: "The source exceeds the converter's 150 MiB limit. Try a shorter or smaller public video.", retryable: false, category: "availability" } };
  }
  if (/reel-unavailable|not found|does not exist|removed|deleted|no longer available|expired media/.test(message)) {
    return { status: 404, payload: { code: "REEL_UNAVAILABLE", title: "This Reel could not be found", error: "The post may have been removed, the link may be mistyped, or Instagram may have stopped serving the media.", retryable: false, category: "availability" } };
  }
  if (/no-public-media|no-public-video-metadata|no media in embed payload|resolver-no-media|resolver-no-video|media-not-public|instagram-page-unavailable|extract_failed/.test(message)) {
    return { status: 422, payload: { code: "NO_PUBLIC_MEDIA", title: "No publicly playable video was found", error: "Instagram did not expose a playable video to the converter. The Reel may be private, login-gated, age/region-restricted, removed, or temporarily unavailable. Instagram's response doesn't let us distinguish those cases reliably.", retryable: false, category: "availability" } };
  }
  if (/resolver-(?:http|failed)|provider-not-configured|provider-no-media|provider-request-failed|dns|fetch failed|econnreset/.test(message)) {
    return { status: 503, payload: { code: "RESOLVER_UNAVAILABLE", title: "The media resolver is temporarily unavailable", error: "The link lookup service did not respond successfully. Try again in a little while.", retryable: true, category: "service" } };
  }
  return { status: 502, payload: { code: "CONVERSION_FAILED", title: "We couldn't convert this Reel", error: "The source could not be converted into an MP3. Check that the link is correct and publicly accessible, then try again.", retryable: true, category: "conversion" } };
}


app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req: Request, res: Response, next: NextFunction) => {
  res.locals.cspNonce = crypto.randomBytes(18).toString("base64");
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", (_req: Request, res: Response) => "'nonce-" + res.locals.cspNonce + "'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  originAgentCluster: true,
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  noSniff: true,
  xssFilter: false,
  xDnsPrefetchControl: { allow: false },
  xDownloadOptions: true,
  xPermittedCrossDomainPolicies: { permittedPolicies: "none" },
  frameguard: { action: "deny" },
  referrerPolicy: { policy: "no-referrer" }
}));
app.use(express.json({ limit: "12kb", strict: true }));

// Render the entry page with a per-response nonce for structured-data scripts.
app.get("/", (req: Request, res: Response, next: NextFunction) => {
  fs.readFile(path.join(__dirname, "public", "index.html"), "utf8", (error, markup) => {
    if (error) return next(error);
    const nonce = String(res.locals.cspNonce || "");
    const html = markup.replaceAll('<script type="application/ld+json">', '<script type="application/ld+json" nonce="' + nonce + '">');
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  });
});

// Serve public assets in both Vercel and local deployments.
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

function clientKey(req: Request): string {
  // Keep the full address only as a short-lived value during this request.
  return String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100);
}


function validateInstagramUrl(raw: unknown): ValidatedInstagramUrl | InvalidInstagramUrl {
  if (typeof raw !== "string" || raw.length > 2048) {
    return { ok: false, reason: "Paste a valid Instagram Reel link." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That link doesn't look like a valid URL." };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(hostname) ||
    parsed.username ||
    parsed.password
  ) {
    return { ok: false, reason: "Use a public Instagram Reel link that starts with https://www.instagram.com/." };
  }

  const sharedCode = parsed.pathname.match(sharedPostPath)?.[1];
  if (!regularPostPath.test(parsed.pathname) && !sharedCode) {
    return { ok: false, reason: "That URL doesn't look like an Instagram Reel or video post link." };
  }
  if (sharedCode) parsed.pathname = "/reel/" + sharedCode + "/";

  parsed.search = "";
  parsed.hash = "";
  parsed.hostname = "www.instagram.com";
  return { ok: true, url: parsed.toString() };
}

function getSql(): ReturnType<typeof neon> | null {
  if (!process.env.DATABASE_URL) return null;
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function makeIpHash(ip: string): string {
  const configuredSecret = process.env.RATE_LIMIT_SECRET;
  if (process.env.NODE_ENV === "production" &&
      (!configuredSecret || Buffer.byteLength(configuredSecret, "utf8") < 32)) {
    throw new Error("RATE_LIMIT_SECRET must be configured with at least 32 bytes in production");
  }
  const secret = configuredSecret || "reeltone-local-rate-limit";
  // Hash only the truncated network prefix. No raw IP or masked prefix is persisted.
  return crypto.createHmac("sha256", secret).update(maskClientIp(ip), "utf8").digest("hex");
}


const DEFAULT_SOURCE_COOLDOWN_SECONDS = 300;
const MAX_SOURCE_COOLDOWN_SECONDS = 3600;
type SourceCooldownKey = "instagram" | "resolver" | "easydown";
const localSourceCooldowns = new Map<SourceCooldownKey, { until: number; strikeCount: number }>();

function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && trimmed !== "") {
    return Math.min(MAX_SOURCE_COOLDOWN_SECONDS, Math.max(1, Math.ceil(numeric)));
  }
  const dateValue = Date.parse(trimmed);
  if (!Number.isFinite(dateValue)) return undefined;
  return Math.min(MAX_SOURCE_COOLDOWN_SECONDS, Math.max(1, Math.ceil((dateValue - Date.now()) / 1000)));
}

async function getSourceCooldownSeconds(source: SourceCooldownKey): Promise<number> {
  const sql = getSql();
  if (!sql) {
    const current = localSourceCooldowns.get(source);
    return current ? Math.max(0, Math.ceil((current.until - Date.now()) / 1000)) : 0;
  }
  const rows = await sql`
    SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (cooldown_until - now()))))::int AS remaining_seconds
    FROM reeltone_source_cooldowns
    WHERE cooldown_key = ${source} AND cooldown_until > now()
    LIMIT 1
  `;
  return Math.min(MAX_SOURCE_COOLDOWN_SECONDS, Math.max(0, Number(rows[0]?.remaining_seconds || 0)));
}

async function registerSourceCooldown(source: SourceCooldownKey, retryAfterSeconds?: number): Promise<number> {
  const requested = Math.min(MAX_SOURCE_COOLDOWN_SECONDS, Math.max(1, Math.ceil(retryAfterSeconds || DEFAULT_SOURCE_COOLDOWN_SECONDS)));
  const sql = getSql();
  if (!sql) {
    const previous = localSourceCooldowns.get(source);
    const isActive = !!previous && previous.until > Date.now();
    const strikeCount = previous ? (isActive ? previous.strikeCount : Math.min(8, previous.strikeCount + 1)) : 1;
    const backoff = Math.min(MAX_SOURCE_COOLDOWN_SECONDS, DEFAULT_SOURCE_COOLDOWN_SECONDS * (2 ** (strikeCount - 1)));
    const duration = Math.max(requested, backoff);
    localSourceCooldowns.set(source, { until: Math.max(previous?.until || 0, Date.now() + duration * 1000), strikeCount });
    return Math.max(1, Math.ceil((localSourceCooldowns.get(source)!.until - Date.now()) / 1000));
  }

  const existing = await sql`
    SELECT strike_count, (cooldown_until > now()) AS active
    FROM reeltone_source_cooldowns
    WHERE cooldown_key = ${source}
    LIMIT 1
  `;
  const oldStrikeCount = Number(existing[0]?.strike_count || 0);
  const stillActive = existing[0]?.active === true;
  const strikeCount = oldStrikeCount === 0 ? 1 : (stillActive ? oldStrikeCount : Math.min(8, oldStrikeCount + 1));
  const backoff = Math.min(MAX_SOURCE_COOLDOWN_SECONDS, DEFAULT_SOURCE_COOLDOWN_SECONDS * (2 ** (strikeCount - 1)));
  const duration = Math.max(requested, backoff);
  await sql`
    INSERT INTO reeltone_source_cooldowns (cooldown_key, cooldown_until, strike_count, updated_at)
    VALUES (${source}, now() + (${duration} * interval '1 second'), ${strikeCount}, now())
    ON CONFLICT (cooldown_key) DO UPDATE SET
      cooldown_until = GREATEST(reeltone_source_cooldowns.cooldown_until, EXCLUDED.cooldown_until),
      strike_count = GREATEST(reeltone_source_cooldowns.strike_count, EXCLUDED.strike_count),
      updated_at = now()
  `;
  return await getSourceCooldownSeconds(source) || duration;
}

function sourceCooldownError(res: Response, source: SourceCooldownKey, remainingSeconds: number): Response {
  const seconds = Math.min(MAX_SOURCE_COOLDOWN_SECONDS, Math.max(1, Math.ceil(remainingSeconds || DEFAULT_SOURCE_COOLDOWN_SECONDS)));
  const isInstagram = source === "instagram";
  const isResolver = source === "resolver";
  const code: ApiErrorCode = isInstagram ? "INSTAGRAM_RATE_LIMITED" : (isResolver ? "RESOLVER_RATE_LIMITED" : "PROVIDER_RATE_LIMITED");
  const title = isInstagram ? "Instagram is temporarily limiting requests" :
    (isResolver ? "The link lookup service is cooling down" : "The media provider is cooling down");
  const error = isInstagram
    ? "ReelTone has paused further Instagram requests to respect the source limit. Wait for the cooldown instead of retrying repeatedly."
    : "ReelTone has paused requests to this lookup provider and will avoid calling it again until its cooldown expires.";
  return sendApiError(res, 503, {
    code, title, error, retryable: true, category: "rate-limit", retryAfterSeconds: seconds
  });
}

async function checkRateLimit(ip: string): Promise<boolean> {
  const sql = getSql();
  const ipHash = makeIpHash(ip);
  if (!sql) {
    // Local fallback stores only keyed pseudonyms, never IP addresses or subnets.
    const now = Date.now();
    const recent = (requestsByIp.get(ipHash) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= MAX_REQUESTS_PER_HOUR) {
      requestsByIp.set(ipHash, recent);
      return false;
    }
    recent.push(now);
    requestsByIp.set(ipHash, recent);
    return true;
  }
  const rows = await sql`
    INSERT INTO conversion_usage (ip_hash, window_start, request_count)
    VALUES (${ipHash}, date_trunc('hour', now()), 1)
    ON CONFLICT (ip_hash, window_start)
    DO UPDATE SET request_count = conversion_usage.request_count + 1
    RETURNING request_count
  `;

  localRequestCounter += 1;
  if (localRequestCounter % 40 === 0) {
    // Keep the small rate-limit table bounded without a separate worker.
    sql`DELETE FROM conversion_usage WHERE window_start < now() - interval '48 hours'`.catch(() => {});
  }
  return Number(rows[0]?.request_count || 0) <= MAX_REQUESTS_PER_HOUR;
}

function safeExtractorDiagnostic(stderr: unknown, error: any): string {
  const combined = [
    String(stderr || ""),
    String(error?.stderr || ""),
    String(error?.message || "")
  ].join("\n");
  const redacted = combined
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/www\.instagram\.com\/[^\s"'<>]+/gi, "[instagram-url]")
    .replace(/(cookie|authorization|password|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  const lines = redacted.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /(ERROR:|HTTP Error|unable to|not found|forbidden|login required|no video|no formats|ffmpeg|extractaudio|rate.?limit|429|403|traceback|failed to)/i.test(line));
  return lines.slice(-3).join(" | ").slice(0, 500) || "no extractor diagnostic";
}

function safeConversionError(error: any, timedOut: boolean): string {
  if (timedOut) return "This Reel took too long to process. Try a shorter Reel.";
  const message = String(error?.stderr || error?.message || "").toLowerCase();

  if (/(?:duration[^\n]{0,80}(?:exceeds?|greater than|longer than|above|over|>\s*\d+)|(?:exceeds?|greater than|longer than|over|>\s*\d+)[^\n]{0,80}duration|video too long|filtered out[^\n]{0,80}duration|duration[^\n]{0,80}(?:limit|1200\s*(?:s|seconds)|20\s*minutes))/i.test(message)) {
    return "This video is longer than the 20-minute limit.";
  }
  if (/login|required|private|401|403|challenge|checkpoint|rate.?limit|429|not authorized/.test(message)) {
    return "Instagram couldn't provide this media publicly. The Reel may be private, login-gated, unavailable, or temporarily restricted.";
  }
  if (/unsupported url|does not exist|not available|404|no video|could not find/.test(message)) {
    return "We couldn't find a playable video at that link. Check the URL and try again.";
  }
  if (/spawn|enoent|ffmpeg|executable/.test(message)) {
    return "The conversion engine isn't ready. Please try again shortly.";
  }
  return "Couldn't extract audio from that link. Make sure the Reel is public, then try again.";
}


const INSTAGRAM_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const MAX_SOURCE_BYTES = 150 * 1024 * 1024;

function getConfiguredMediaResolverUrl(): string | null {
  const configured = process.env.MEDIA_RESOLVER_URL?.trim();
  if (!configured) return null;

  try {
    const endpoint = new URL(configured);
    const host = endpoint.hostname.toLowerCase();
    const localHostname = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      localHostname ||
      net.isIP(host) !== 0
    ) {
      console.error("MEDIA_RESOLVER_URL is invalid; optional resolver disabled.");
      return null;
    }
    return endpoint.toString();
  } catch {
    console.error("MEDIA_RESOLVER_URL is invalid; optional resolver disabled.");
    return null;
  }
}

function timestampedDownloadFilename(title?: string): string {
  const normalized = String(title || "reeltone")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .toLowerCase() || "reeltone";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = crypto.randomBytes(4).toString("hex");
  return normalized + "-" + timestamp + "-" + suffix + ".mp3";
}

function isAllowedMediaAsset(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (host === "cdninstagram.com" ||
        host.endsWith(".cdninstagram.com") ||
        host === "fbcdn.net" ||
        host.endsWith(".fbcdn.net"));
  } catch {
    return false;
  }
}

function extractInstagramVideoVersions(html: string): VideoVersion[] {
  const directVideos: VideoVersion[] = [];
  const directPattern = /\\?"video_url\\?"\s*:\s*\\?"(https?:[^"]+)/gi;
  let directMatch;
  while ((directMatch = directPattern.exec(html)) !== null) {
    let url = directMatch[1];
    url = url
      .replace(/\\u00253D/gi, "%3D")
      .replace(/\\u0026/gi, "&")
      .replace(/\\+\//g, "/")
      .replace(/\\+$/g, "")
      .replace(/\\/g, "");
    if (isAllowedMediaAsset(url) && !directVideos.some((item) => item.url === url)) {
      directVideos.push({ url, width: 0, height: 0 });
    }
  }

  const marker = "video_versions";
  const keyPosition = html.indexOf(marker);
  if (keyPosition < 0) return directVideos;

  const colon = html.indexOf(":", keyPosition + marker.length);
  const arrayStart = html.indexOf("[", colon);
  if (colon < 0 || arrayStart < 0 || arrayStart - colon > 24) {
    return directVideos;
  }

  let depth = 0;
  let quoted = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length; i++) {
    const character = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else {
      if (character === '"') quoted = true;
      else if (character === "[") depth++;
      else if (character === "]") {
        depth--;
        if (depth === 0) {
          arrayEnd = i + 1;
          break;
        }
      }
    }
  }

  if (arrayEnd < 0) return directVideos;
  try {
    const versions = JSON.parse(
      html.slice(arrayStart, arrayEnd)
        .replaceAll("\\/", "/")
        .replaceAll("\\u0026", "&")
    );
    if (!Array.isArray(versions)) return directVideos;
    const validVersions = versions
      .filter((item) => item && typeof item.url === "string" && isAllowedMediaAsset(item.url))
      .sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) -
                      (Number(a.width || 0) * Number(a.height || 0)));
    const combined = [...validVersions, ...directVideos];
    return combined.filter((item, index) => combined.findIndex((x) => x.url === item.url) === index);
  } catch {
    return directVideos;
  }
}
function getInstagramVideoDuration(html: string): number | null {
  const match = html.match(/"video_duration"\s*:\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

async function fetchInstagramMediaAsset(rawUrl: string, parentSignal: AbortSignal): Promise<MediaAssetAttempt> {
  let current = rawUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedMediaAsset(current)) {
      return { ok: false, reason: "untrusted-media-host" };
    }

    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": INSTAGRAM_BROWSER_UA,
        "Referer": "https://www.instagram.com/",
        "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.5"
      },
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(60000)])
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 3) return { ok: false, reason: "media-redirect-failed" };
      current = new URL(location, current).toString();
      continue;
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "instagram-rate-limited", retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")) };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: "media-not-public" };
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_SOURCE_BYTES) {
      await response.body.cancel().catch(() => {});
      return { ok: false, reason: "media-too-large" };
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("video") && !current.toLowerCase().includes(".mp4")) {
      await response.body.cancel().catch(() => {});
      return { ok: false, reason: "not-a-video" };
    }

    return { ok: true, response, url: current, contentLength };
  }
  return { ok: false, reason: "media-redirect-failed" };
}

async function encodeDownloadedVideo(inputPath: string, outputPath: string, quality: QualityPreset, signal: AbortSignal, setProcess: ProcessSetter): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("conversion cancelled"));
      return;
    }

    let finished = false;
    let timedOut = false;
    let stderr = "";
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-nostdin",
      "-loglevel", "error",
      "-y",
      "-i", inputPath,
      "-vn",
      "-map", "0:a:0?",
      "-codec:a", "libmp3lame",
      "-b:a", String(quality) + "k",
      "-map_metadata", "-1",
      "-f", "mp3",
      outputPath
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    setProcess(child);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 90000);
    timeout.unref?.();

    const abortHandler = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abortHandler, { once: true });

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortHandler);
      setProcess(null);
      if (error) reject(error);
      else resolve(true);
    };

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (signal.aborted) return finish(new Error("conversion cancelled"));
      if (timedOut) return finish(new Error("ffmpeg timeout"));
      if (code !== 0) return finish(new Error(stderr || "ffmpeg could not encode audio"));
      try {
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 128) {
          return finish(new Error("ffmpeg produced no usable audio"));
        }
        return finish(null);
      } catch (error) {
        return finish(error);
      }
    });
  });
}

async function tryPublicResolverToMp3(sourceUrl: string, directory: string, outputPath: string, quality: QualityPreset, parentSignal: AbortSignal, setProcess: ProcessSetter, resolverEndpoint: string): Promise<ConversionAttempt> {
  const inputPath = path.join(directory, "resolver-source.mp4");
  try {
    const resolverUrl = new URL(resolverEndpoint);
    resolverUrl.searchParams.set("url", sourceUrl);

    const response = await fetch(resolverUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": INSTAGRAM_BROWSER_UA
      },
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(12000)])
    });
    if (response.status === 429) {
      return { ok: false, reason: "resolver-rate-limited", retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")) };
    }
    if (!response.ok) {
      if (response.status === 404) return { ok: false, reason: "reel-unavailable" };
      return { ok: false, reason: "resolver-http-" + response.status };
    }

    const payload = await response.json().catch(() => null) as PublicResolverPayload | null;
    if (!payload || payload.ok !== true || !Array.isArray(payload.media)) {
      const upstreamText = String(payload?.code || "") + " " + String(payload?.error || payload?.message || "");
      const lower = upstreamText.toLowerCase();
      let reason = "no-public-media";
      if (payload.private === true || payload.is_private === true || /private|is_private/.test(lower)) reason = "private-reel";
      else if (payload.login_required === true || payload.requires_login === true || /login[-_ ]required|sign in|authentication required/.test(lower)) reason = "login-required";
      else if (/rate.?limit|too many requests|429/.test(lower)) {
        reason = /instagram|source/.test(lower) ? "instagram-rate-limited" : "resolver-rate-limited";
      }
      else if (/not found|removed|deleted|does not exist/.test(lower)) reason = "reel-unavailable";
      return { ok: false, reason, retryAfterSeconds: parseRetryAfterSeconds(String((payload as any)?.retry_after || (payload as any)?.retryAfter || "")), detail: upstreamText.slice(0, 180) };
    }

    const candidates = payload.media.filter((item) =>
      item &&
      item.type === "video" &&
      typeof item.url === "string" &&
      isAllowedMediaAsset(item.url)
    );
    const selected = candidates[0];
    if (!selected) return { ok: false, reason: "resolver-no-video" };

    const duration = Number(payload.duration || selected.duration || 0);
    if (duration > MAX_DURATION_SECONDS) return { ok: false, reason: "duration-limit" };

    const media = await fetchInstagramMediaAsset(selected.url, parentSignal);
    if ("reason" in media) return { ok: false, reason: media.reason || "media-not-public", retryAfterSeconds: media.retryAfterSeconds };
    if (media.contentLength > MAX_SOURCE_BYTES) {
      await media.response.body?.cancel().catch(() => {});
      return { ok: false, reason: "media-too-large" };
    }

    let totalBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_SOURCE_BYTES) callback(new Error("source video exceeded the size limit"));
        else callback(null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(media.response.body as any),
        limiter,
        fs.createWriteStream(inputPath, { flags: "wx" }),
        { signal: AbortSignal.any([parentSignal, AbortSignal.timeout(60000)]) }
      );
    } catch (error) {
      fs.rmSync(inputPath, { force: true });
      if (error?.name === "AbortError" || error?.name === "TimeoutError") return { ok: false, reason: "media-download-timeout" };
      if (/size limit/.test(String(error?.message || ""))) return { ok: false, reason: "media-too-large" };
      return { ok: false, reason: "media-download-failed" };
    }

    if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
    await encodeDownloadedVideo(inputPath, outputPath, quality, parentSignal, setProcess);
    return {
      ok: true,
      reason: "public-resolver",
      title: typeof payload.title === "string" ? payload.title.slice(0, 180) : undefined,
      author: typeof payload.author === "string" ? payload.author.slice(0, 80) : undefined
    };
  } catch (error) {
    if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
    return {
      ok: false,
      reason: "public-resolver-failed",
      diagnostic: safeExtractorDiagnostic(String(error?.message || ""), null)
    };
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
  }
}

async function tryPublicHtmlToMp3(sourceUrl: string, directory: string, outputPath: string, quality: QualityPreset, parentSignal: AbortSignal, setProcess: ProcessSetter): Promise<ConversionAttempt> {
  const inputPath = path.join(directory, "source.mp4");
  try {
    const canonical = new URL(sourceUrl);
    const canonicalPath = canonical.pathname.replace(/\/+$/, "");
    const shortCode = canonicalPath.match(/^\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)$/i)?.[1];
    const pageCandidates = [
      "https://www.instagram.com" + canonicalPath + "/embed/",
      "https://www.instagram.com" + canonicalPath + "/embed/captioned/",
      ...(shortCode ? [
        "https://www.instagram.com/p/" + shortCode + "/embed/",
        "https://www.instagram.com/p/" + shortCode + "/embed/captioned/"
      ] : []),
      sourceUrl
    ];

    let selected: VideoVersion | null = null;
    let duration: number | null = null;
    let lastReason = "no-public-video-metadata";
    const pageDiagnostics = [];

    // The embed route can expose a public post's media metadata even when
    // the normal page responds with a login wall to datacenter requests.
    for (const pageUrl of pageCandidates) {
      const pageLabel = pageUrl.includes("/embed/") ? (pageUrl.includes("captioned") ? "embed-captioned" : "embed") : "page";
      let pageResponse;
      try {
        pageResponse = await fetch(pageUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": INSTAGRAM_BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.instagram.com/"
          },
          signal: AbortSignal.any([parentSignal, AbortSignal.timeout(14000)])
        });
      } catch (error) {
        if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
        lastReason = error?.name === "TimeoutError" ? "instagram-page-timeout" : "instagram-page-unavailable";
        pageDiagnostics.push(`${pageLabel}:fetch-${error?.name || "error"}`);
        continue;
      }

      const finalUrl = pageResponse.url || pageUrl;
      const finalParsed = new URL(finalUrl);
      const finalHost = finalParsed.hostname.toLowerCase();
      if (ALLOWED_HOSTS.has(finalHost) && /^\/accounts\/login\/?$/i.test(finalParsed.pathname)) {
        await pageResponse.body?.cancel().catch(() => {});
        return { ok: false, reason: "login-required", diagnostic: pageLabel + ":redirected-to-login" };
      }
      if (pageResponse.status === 429) {
        await pageResponse.body?.cancel().catch(() => {});
        return { ok: false, reason: "instagram-rate-limited", retryAfterSeconds: parseRetryAfterSeconds(pageResponse.headers.get("retry-after")), diagnostic: pageLabel + ":http-429" };
      }
      if (!pageResponse.ok || !ALLOWED_HOSTS.has(finalHost)) {
        await pageResponse.body?.cancel().catch(() => {});
        lastReason = pageResponse.status === 404 ? "reel-unavailable" : "instagram-page-unavailable";
        pageDiagnostics.push(`${pageLabel}:http-${pageResponse.status}:${ALLOWED_HOSTS.has(finalHost) ? "ig" : "redirect"}`);
        continue;
      }

      const pageLength = Number(pageResponse.headers.get("content-length") || 0);
      if (pageLength > 5 * 1024 * 1024) {
        await pageResponse.body?.cancel().catch(() => {});
        lastReason = "instagram-page-too-large";
        pageDiagnostics.push(`${pageLabel}:length-header-too-large`);
        continue;
      }

      let html;
      try {
        html = await pageResponse.text();
      } catch {
        lastReason = "instagram-page-unavailable";
        pageDiagnostics.push(`${pageLabel}:body-read-failed`);
        continue;
      }
      if (html.length > 5 * 1024 * 1024) {
        lastReason = "instagram-page-too-large";
        pageDiagnostics.push(`${pageLabel}:html-too-large`);
        continue;
      }
      if (/please wait a few minutes before you try again|too many requests|rate.?limit exceeded|temporarily blocked/i.test(html)) {
        return { ok: false, reason: "instagram-rate-limited", diagnostic: pageLabel + ":rate-limit-page" };
      }

      if (/<title>\\s*Page Not Found\\b/i.test(html) || /"message"\\s*:\\s*"This page is not available/i.test(html)) {
        return { ok: false, reason: "reel-unavailable", diagnostic: pageLabel + ":page-not-found" };
      }
      const explicitPrivate = /"is_private"\\s*:\\s*true|"private"\\s*:\\s*true|this account is private|this reel is private|this video is private/i.test(html);
      if (explicitPrivate) {
        return { ok: false, reason: "private-reel", diagnostic: pageLabel + ":explicit-private-signal" };
      }
      const explicitLogin = /"error_type"\\s*:\\s*"login_required"|"login_required"\\s*:\\s*true|"message"\\s*:\\s*"[^"]{0,100}login required|redirected to the login page/i.test(html);
      if (explicitLogin) {
        return { ok: false, reason: "login-required", diagnostic: pageLabel + ":explicit-login-signal" };
      }

      const candidateDuration = getInstagramVideoDuration(html);
      if (candidateDuration !== null) {
        duration = candidateDuration;
        if (duration > MAX_DURATION_SECONDS) return { ok: false, reason: "duration-limit" };
      }

      const versions = extractInstagramVideoVersions(html);
      pageDiagnostics.push(`${pageLabel}:${pageResponse.status}:${html.length}:${/video_url/i.test(html) ? 1 : 0}:${/video_versions/i.test(html) ? 1 : 0}:${versions.length}`);
      if (versions.length) {
        selected = versions[0];
        break;
      }
      lastReason = "no-public-video-metadata";
    }

    if (!selected) return { ok: false, reason: lastReason, diagnostic: pageDiagnostics.join(",").slice(0, 300) };

    const media = await fetchInstagramMediaAsset(selected.url, parentSignal);
    if ("reason" in media) return { ok: false, reason: media.reason || "media-not-public", retryAfterSeconds: media.retryAfterSeconds };

    let totalBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_SOURCE_BYTES) callback(new Error("source video exceeded the size limit"));
        else callback(null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(media.response.body as any),
        limiter,
        fs.createWriteStream(inputPath, { flags: "wx" }),
        { signal: AbortSignal.any([parentSignal, AbortSignal.timeout(60000)]) }
      );
    } catch (error) {
      fs.rmSync(inputPath, { force: true });
      if (error?.name === "AbortError") return { ok: false, reason: "media-download-timeout" };
      if (/size limit/.test(String(error?.message || ""))) return { ok: false, reason: "media-too-large" };
      return { ok: false, reason: "media-download-failed" };
    }

    if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
    await encodeDownloadedVideo(inputPath, outputPath, quality, parentSignal, setProcess);
    return { ok: true, reason: "public-html-media" };
  } catch (error) {
    if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
    return {
      ok: false,
      reason: "public-html-fallback-failed",
      diagnostic: safeExtractorDiagnostic(String(error?.message || ""), null)
    };
  } finally {
    fs.rm(path.join(directory, "source.mp4"), { force: true }, () => {});
  }
}

async function tryEasyDownToMp3(sourceUrl: string, directory: string, outputPath: string, quality: QualityPreset, parentSignal: AbortSignal, setProcess: ProcessSetter): Promise<ConversionAttempt> {
  const token = process.env.EASYDOWN_API_TOKEN;
  if (!token) return { ok: false, reason: "provider-not-configured" };

  try {
    const response = await fetch("https://api.easydown.org/api/v1/platforms/instagram/parse", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ url: sourceUrl }),
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(15000)])
    });

    const payload = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "provider-auth-failed" };
    }
    if (response.status === 429 || Number(payload?.status || 0) === 429) {
      return { ok: false, reason: "provider-rate-limited", retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")) };
    }
    if (!response.ok || !payload || Number(payload.status || response.status) >= 400) {
      const bodyError = String(payload?.error || payload?.message || payload?.code || "").toLowerCase();
      if (/rate.?limit|too many requests|http error 429/.test(bodyError)) {
        const sourceLimited = /instagram|source/.test(bodyError);
        return { ok: false, reason: sourceLimited ? "instagram-rate-limited" : "provider-rate-limited", retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")) };
      }
      return { ok: false, reason: "provider-no-media" };
    }

    const media = payload?.data?.media || payload?.data;
    if (!media || !Array.isArray(media.videos) && !Array.isArray(media.audios)) {
      return { ok: false, reason: "provider-no-media" };
    }

    const duration = Number(media.duration || 0);
    if (duration > MAX_DURATION_SECONDS) return { ok: false, reason: "duration-limit" };

    const candidates = [
      ...(Array.isArray(media.audios) ? media.audios : []),
      ...(Array.isArray(media.videos) ? media.videos.filter((item) => item?.hasAudio !== false) : [])
    ];
    const chosen = candidates.find((item) => typeof item?.url === "string" && isAllowedMediaAsset(item.url));
    if (!chosen) return { ok: false, reason: "provider-no-media" };

    const downloaded = await fetchInstagramMediaAsset(chosen.url, parentSignal);
    if ("reason" in downloaded) return { ok: false, reason: downloaded.reason || "media-not-public" };
    if (downloaded.contentLength > MAX_SOURCE_BYTES) {
      await downloaded.response.body?.cancel().catch(() => {});
      return { ok: false, reason: "media-too-large" };
    }

    const inputPath = path.join(directory, "provider-source.bin");
    let totalBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_SOURCE_BYTES) callback(new Error("source media exceeded the size limit"));
        else callback(null, chunk);
      }
    });

    try {
      await pipeline(
        Readable.fromWeb(downloaded.response.body as any),
        limiter,
        fs.createWriteStream(inputPath, { flags: "wx" }),
        { signal: AbortSignal.any([parentSignal, AbortSignal.timeout(60000)]) }
      );
    } catch (error) {
      fs.rmSync(inputPath, { force: true });
      if (error?.name === "AbortError") return { ok: false, reason: "media-download-timeout" };
      if (/size limit/.test(String(error?.message || ""))) return { ok: false, reason: "media-too-large" };
      return { ok: false, reason: "media-download-failed" };
    }

    await encodeDownloadedVideo(inputPath, outputPath, quality, parentSignal, setProcess);
    return { ok: true, reason: "easydown" };
  } catch (error) {
    if (parentSignal.aborted) return { ok: false, reason: "cancelled" };
    return {
      ok: false,
      reason: "provider-request-failed",
      diagnostic: safeExtractorDiagnostic(String(error?.message || ""), null)
    };
  } finally {
    fs.rm(path.join(directory, "provider-source.bin"), { force: true }, () => {});
  }
}


app.get("/api/health", async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const sql = getSql();
    if (!sql) throw new Error("DATABASE_URL is not configured");
    await sql`SELECT 1 AS ok`;
    return res.json({ ok: true, service: "reeltone", database: "connected", maxDurationSeconds: MAX_DURATION_SECONDS });
  } catch {
    return sendApiError(res, 503, { code: "DATABASE_UNAVAILABLE", title: "Service health check failed", error: "The application is live, but its dedicated Neon database is not reachable.", retryable: true, category: "service" });
  }
});
app.get("/api/health/badge", async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  try {
    const sql = getSql();
    if (!sql) throw new Error("DATABASE_URL is not configured");
    await sql`SELECT 1 AS ok`;
    return res.status(200).json({ schemaVersion: 1, label: "site & database", message: "operational", color: "brightgreen", namedLogo: "vercel" });
  } catch {
    return res.status(200).json({ schemaVersion: 1, label: "site & database", message: "unavailable", color: "red", isError: true, namedLogo: "vercel" });
  }
});

app.post("/api/convert", async (req: Request, res: Response) => {
  const validated = validateInstagramUrl(req.body?.url);
  if (!validated.ok) return sendApiError(res, 400, { code: "INVALID_URL", title: "Check your Instagram link", error: validated.reason, retryable: false, category: "input" });

  const requestedQuality = String(req.body?.quality || "192");
  if (!QUALITY_PRESETS.has(requestedQuality)) {
    return sendApiError(res, 400, { code: "INVALID_QUALITY", title: "Choose an audio quality", error: "Select 128, 192, 256, or 320 kbps, then start the conversion again.", retryable: false, category: "input" });
  }

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    return sendApiError(res, 503, { code: "ENGINE_UNAVAILABLE", title: "The audio engine isn't ready", error: "The conversion engine is unavailable in this deployment. Please try again shortly.", retryable: true, category: "service" });
  }

  try {
    const sourceCooldown = await getSourceCooldownSeconds("instagram");
    if (sourceCooldown > 0) return sourceCooldownError(res, "instagram", sourceCooldown);
    if (!(await checkRateLimit(clientKey(req)))) {
      return sendApiError(res, 429, { code: "RATE_LIMITED", title: "Hourly conversion limit reached", error: "This site allows eight conversion attempts per hour per visitor. Please wait for the limit to reset before trying again.", retryable: true, category: "rate-limit" });
    }
  } catch (error) {
    console.error("Rate-limit database is unavailable:", error?.name || "unknown error");
    return sendApiError(res, 503, { code: "DATABASE_UNAVAILABLE", title: "The converter is temporarily unavailable", error: "The rate-limit database could not be reached. No conversion was started; please try again shortly.", retryable: true, category: "service" });
  }

  const quality = requestedQuality as QualityPreset;
  const id = crypto.randomUUID();
  const directory = path.join(os.tmpdir(), "reeltone", id);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return sendApiError(res, 500, { code: "CONVERSION_FAILED", title: "Couldn't prepare the conversion", error: "The temporary workspace could not be created. Please try again.", retryable: true, category: "service" });
  }

  const outputPath = path.join(directory, "audio.mp3");
  let audioTitle: string | undefined;
  let audioAuthor: string | undefined;
  const cleanup = () => fs.rm(directory, { recursive: true, force: true }, () => {});
  let child: any = null;
  let fallbackChild: ChildProcess | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let timedOut = false;
  let clientDisconnected = false;
  let stderrTail = "";
  let stdoutTail = "";
  const fallbackController = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      fallbackController.abort();
      if (child && typeof child.kill === "function") child.kill("SIGTERM");
      if (fallbackChild && typeof fallbackChild.kill === "function") fallbackChild.kill("SIGKILL");
      if (timeout) clearTimeout(timeout);
      cleanup();
    }
  });

  const streamResult = async () => {
    const size = fs.statSync(outputPath).size;
    if (size < 128) throw new Error("MP3 output was empty");
    const downloadFilename = timestampedDownloadFilename(audioTitle);
    res.status(200);
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": 'attachment; filename="' + downloadFilename + '"',
      "X-ReelTone-Filename": downloadFilename,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "X-ReelTone-Quality": quality,
      ...(audioTitle ? { "X-ReelTone-Title": encodeURIComponent(audioTitle.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 180)) } : {}),
      ...(audioAuthor ? { "X-ReelTone-Author": encodeURIComponent(audioAuthor.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 80)) } : {}),
      "Content-Length": String(size)
    });
    try {
      await pipeline(fs.createReadStream(outputPath), res);
    } finally {
      cleanup();
    }
  };

  let providerFallback: ConversionAttempt = { ok: false, reason: "not-attempted" };
  let publicFallback: ConversionAttempt = { ok: false, reason: "not-attempted" };
  let publicResolver: ConversionAttempt = { ok: false, reason: "not-attempted" };
  let extractorError: any = null;

  try {
    publicFallback = await tryPublicHtmlToMp3(
      validated.url,
      directory,
      outputPath,
      quality,
      fallbackController.signal,
      (process) => { fallbackChild = process; }
    );

    if (clientDisconnected || res.destroyed || fallbackController.signal.aborted) {
      cleanup();
      return;
    }
    if (publicFallback.reason === "instagram-rate-limited") {
      const seconds = await registerSourceCooldown("instagram", publicFallback.retryAfterSeconds);
      cleanup();
      return sourceCooldownError(res, "instagram", seconds);
    }
    if (publicFallback.ok && fs.existsSync(outputPath)) {
      await streamResult();
      return;
    }
    if (publicFallback.reason === "duration-limit") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LONG", title: "This Reel is longer than the limit", error: "ReelTone supports videos up to 20 minutes per conversion.", retryable: false, category: "availability" });
    }
    if (publicFallback.reason === "media-too-large") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LARGE", title: "This video is too large to process", error: "The source exceeds the converter's 150 MiB limit. Try a shorter or smaller public video.", retryable: false, category: "availability" });
    }
    if (["private-reel", "login-required", "reel-unavailable"].includes(publicFallback.reason)) {
      cleanup();
      const failure = classifyConversionFailure(publicFallback.reason + " " + String(publicFallback.diagnostic || ""));
      return sendApiError(res, failure.status, failure.payload);
    }

    const providerCooldown = await getSourceCooldownSeconds("easydown");
    providerFallback = providerCooldown > 0
      ? { ok: false, reason: "provider-cooldown", retryAfterSeconds: providerCooldown }
      : await tryEasyDownToMp3(
          validated.url,
          directory,
          outputPath,
          quality,
          fallbackController.signal,
          (process) => { fallbackChild = process; }
        );

    if (clientDisconnected || res.destroyed || fallbackController.signal.aborted) {
      cleanup();
      return;
    }
    if (providerFallback.reason === "instagram-rate-limited") {
      const seconds = await registerSourceCooldown("instagram", providerFallback.retryAfterSeconds);
      cleanup();
      return sourceCooldownError(res, "instagram", seconds);
    }
    if (providerFallback.reason === "provider-rate-limited") {
      providerFallback.retryAfterSeconds = await registerSourceCooldown("easydown", providerFallback.retryAfterSeconds);
    }
    if (providerFallback.ok && fs.existsSync(outputPath)) {
      await streamResult();
      return;
    }
    if (providerFallback.reason === "duration-limit") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LONG", title: "This Reel is longer than the limit", error: "ReelTone supports videos up to 20 minutes per conversion.", retryable: false, category: "availability" });
    }
    if (providerFallback.reason === "media-too-large") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LARGE", title: "This video is too large to process", error: "The source exceeds the converter's 150 MiB limit. Try a shorter or smaller public video.", retryable: false, category: "availability" });
    }
    if (process.env.EASYDOWN_API_TOKEN && providerFallback.reason !== "provider-no-media") {
      console.warn("ReelTone provider fallback failed:", String(providerFallback.reason || "unknown").slice(0, 80));
    }

    // Instagram can serve login/rate-limit walls to anonymous serverless IPs.
    // Resolve only the supplied public Reel URL, then download directly from an
    // allow-listed Instagram CDN host and encode the MP3 in this function.
    const resolverEndpoint = getConfiguredMediaResolverUrl();
    if (!resolverEndpoint) {
      publicResolver = { ok: false, reason: "resolver-not-configured" };
    } else {
      const resolverCooldown = await getSourceCooldownSeconds("resolver");
      if (resolverCooldown > 0) {
        publicResolver = { ok: false, reason: "resolver-cooldown", retryAfterSeconds: resolverCooldown };
      } else {
        publicResolver = await tryPublicResolverToMp3(
          validated.url,
          directory,
          outputPath,
          quality,
          fallbackController.signal,
          (process) => { fallbackChild = process; },
          resolverEndpoint
        );
      }
    }

    if (clientDisconnected || res.destroyed || fallbackController.signal.aborted) {
      cleanup();
      return;
    }
    if (publicResolver.reason === "instagram-rate-limited") {
      const seconds = await registerSourceCooldown("instagram", publicResolver.retryAfterSeconds);
      cleanup();
      return sourceCooldownError(res, "instagram", seconds);
    }
    if (publicResolver.reason === "resolver-rate-limited") {
      publicResolver.retryAfterSeconds = await registerSourceCooldown("resolver", publicResolver.retryAfterSeconds);
    }
    if (publicResolver.ok && fs.existsSync(outputPath)) {
      audioTitle = publicResolver.title;
      audioAuthor = publicResolver.author;
      await streamResult();
      return;
    }
    if (publicResolver.reason === "duration-limit") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LONG", title: "This Reel is longer than the limit", error: "ReelTone supports videos up to 20 minutes per conversion.", retryable: false, category: "availability" });
    }
    if (publicResolver.reason === "media-too-large") {
      cleanup();
      return sendApiError(res, 413, { code: "VIDEO_TOO_LARGE", title: "This video is too large to process", error: "The source exceeds the converter's 150 MiB limit. Try a shorter or smaller public video.", retryable: false, category: "availability" });
    }
    if (resolverEndpoint) console.warn("ReelTone optional resolver fallback failed:", String(publicResolver.reason || "unknown").slice(0, 80));

    // Direct Instagram page/embed parsing has already run before optional providers.

    timeout = setTimeout(() => {
      timedOut = true;
      if (child && typeof child.kill === "function") child.kill("SIGKILL");
    }, PROCESS_TIMEOUT_MS);
    timeout.unref?.();

    child = youtubeDl.exec(validated.url, {
      noConfig: true,
      noCacheDir: true,
      noWarnings: true,
      noPlaylist: true,
      newline: true,
      socketTimeout: 12,
      retries: 1,
      fragmentRetries: 1,
      matchFilter: "duration <= " + MAX_DURATION_SECONDS,
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: quality + "K",
      ffmpegLocation: path.dirname(ffmpegPath),
      output: path.join(directory, "audio.%(ext)s")
    }, {
      cwd: directory,
      env: { ...process.env, HOME: directory, TMPDIR: directory },
      windowsHide: true
    });

    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-8000);
    });
    child.stdout?.on("data", (chunk) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-3000);
    });

    await child;
    child = null;
    if (timeout) clearTimeout(timeout);
    timeout = null;

    if (clientDisconnected || res.destroyed) {
      cleanup();
      return;
    }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
      await streamResult();
      return;
    }

    const diagnostic = safeExtractorDiagnostic(stderrTail + "\n" + stdoutTail, null);
    console.warn("ReelTone extractor produced no MP3:", diagnostic);
  } catch (error) {
    extractorError = error;
    if (timeout) clearTimeout(timeout);
    timeout = null;
    child = null;

    if (clientDisconnected || res.destroyed || fallbackController.signal.aborted) {
      cleanup();
      if (!res.writableEnded && res.headersSent) res.destroy();
      return;
    }

    console.warn(
      "ReelTone conversion failed:",
      error?.exitCode ?? error?.name ?? "unknown error",
      "|",
      safeExtractorDiagnostic(stderrTail, error)
    );
  }

  if (clientDisconnected || res.destroyed || res.headersSent) {
    cleanup();
    if (!res.writableEnded && res.headersSent) res.destroy();
    return;
  }

  cleanup();
  const diagnosticText = [
    String(extractorError?.stderr || extractorError?.message || ""),
    stderrTail,
    stdoutTail
  ].join("\\n");
  const failureEvidence = [
    publicResolver.reason,
    publicResolver.detail || "",
    publicResolver.diagnostic || "",
    publicFallback.reason,
    publicFallback.diagnostic || "",
    diagnosticText
  ].join(" ");
  if (/(?:http error 429|429 too many requests|instagram-rate-limited|please wait a few minutes before you try again|instagram.{0,80}rate.?limit)/i.test(diagnosticText)) {
    const seconds = await registerSourceCooldown("instagram");
    return sourceCooldownError(res, "instagram", seconds);
  }
  if (["resolver-rate-limited", "resolver-cooldown"].includes(publicResolver.reason)) {
    const seconds = (await getSourceCooldownSeconds("resolver")) || publicResolver.retryAfterSeconds || DEFAULT_SOURCE_COOLDOWN_SECONDS;
    return sourceCooldownError(res, "resolver", seconds);
  }
  if (["provider-rate-limited", "provider-cooldown"].includes(providerFallback.reason)) {
    const seconds = (await getSourceCooldownSeconds("easydown")) || providerFallback.retryAfterSeconds || DEFAULT_SOURCE_COOLDOWN_SECONDS;
    return sourceCooldownError(res, "easydown", seconds);
  }
  const failure = classifyConversionFailure(failureEvidence, timedOut);
  return sendApiError(res, failure.status, failure.payload);
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  console.error("Request failed:", err?.type || err?.name || "unknown error");
  res.status(err?.status || 500).json({ error: "Something went wrong. Please refresh and try again." });
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`ReelTone listening on port ${PORT}`));
}