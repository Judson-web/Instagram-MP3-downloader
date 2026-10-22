"use strict";

const express = require("express");
const helmet = require("helmet");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const youtubeDl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const { neon } = require("@neondatabase/serverless");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_DURATION_SECONDS = 20 * 60;
const MAX_REQUESTS_PER_HOUR = 8;
const PROCESS_TIMEOUT_MS = 50 * 1000;
const QUALITY_PRESETS = new Set(["128", "192", "320"]);
const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com"
]);
const regularPostPath = /^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i;
const sharedPostPath = /^\/share\/reel\/([A-Za-z0-9_-]+)\/?$/i;
const requestsByIp = new Map();
let localRequestCounter = 0;
let sqlClient;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: "no-referrer" }
}));
app.use(express.json({ limit: "12kb", strict: true }));

// Serve public assets in both Vercel and local deployments.
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

function clientKey(req) {
  return String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100);
}

function validateInstagramUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) {
    return { ok: false, reason: "Paste a valid Instagram Reel link." };
  }

  let parsed;
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

function getSql() {
  if (!process.env.DATABASE_URL) return null;
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function makeIpHash(ip) {
  const secret = process.env.RATE_LIMIT_SECRET || "reeltone-local-rate-limit";
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

async function checkRateLimit(ip) {
  const sql = getSql();
  if (!sql) {
    // Local development fallback only. Production is configured with Neon.
    const now = Date.now();
    const recent = (requestsByIp.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= MAX_REQUESTS_PER_HOUR) {
      requestsByIp.set(ip, recent);
      return false;
    }
    recent.push(now);
    requestsByIp.set(ip, recent);
    return true;
  }

  const ipHash = makeIpHash(ip);
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

function safeExtractorDiagnostic(stderr, error) {
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

function safeConversionError(error, timedOut) {
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

function isAllowedMediaAsset(raw) {
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

function extractInstagramVideoVersions(html) {
  const marker = "video_versions";
  const keyPosition = html.indexOf(marker);
  if (keyPosition < 0) return [];
  const colon = html.indexOf(":", keyPosition + marker.length);
  const arrayStart = html.indexOf("[", colon);
  if (colon < 0 || arrayStart < 0 || arrayStart - colon > 24) return [];

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

  if (arrayEnd < 0) return [];
  try {
    const versions = JSON.parse(
      html.slice(arrayStart, arrayEnd)
        .replaceAll("\\/", "/")
        .replaceAll("\\u0026", "&")
    );
    if (!Array.isArray(versions)) return [];
    return versions
      .filter((item) => item && typeof item.url === "string" && isAllowedMediaAsset(item.url))
      .sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) -
                      (Number(a.width || 0) * Number(a.height || 0)));
  } catch {
    return [];
  }
}

function getInstagramVideoDuration(html) {
  const match = html.match(/"video_duration"\s*:\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

async function fetchInstagramMediaAsset(rawUrl, parentSignal) {
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

async function encodeDownloadedVideo(inputPath, outputPath, quality, signal, setProcess) {
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

async function tryPublicHtmlToMp3(sourceUrl, directory, outputPath, quality, parentSignal, setProcess) {
  const inputPath = path.join(directory, "source.mp4");
  try {
    const pageResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": INSTAGRAM_BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/"
      },
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(20000)])
    });

    if (!pageResponse.ok) return { ok: false, reason: "instagram-page-unavailable" };
    const pageHost = new URL(pageResponse.url || sourceUrl).hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(pageHost)) return { ok: false, reason: "instagram-page-redirected" };

    const pageLength = Number(pageResponse.headers.get("content-length") || 0);
    if (pageLength > 5 * 1024 * 1024) {
      await pageResponse.body?.cancel().catch(() => {});
      return { ok: false, reason: "instagram-page-too-large" };
    }

    const html = await pageResponse.text();
    if (html.length > 5 * 1024 * 1024) return { ok: false, reason: "instagram-page-too-large" };

    const duration = getInstagramVideoDuration(html);
    if (duration !== null && duration > MAX_DURATION_SECONDS) {
      return { ok: false, reason: "duration-limit" };
    }

    const versions = extractInstagramVideoVersions(html);
    if (!versions.length) return { ok: false, reason: "no-public-video-metadata" };

    const selected = versions[0];
    const media = await fetchInstagramMediaAsset(selected.url, parentSignal);
    if (!media.ok) return media;

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
        Readable.fromWeb(media.response.body),
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

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "reeltone", maxDurationSeconds: MAX_DURATION_SECONDS });
});

app.post("/api/convert", async (req, res) => {
  const validated = validateInstagramUrl(req.body?.url);
  if (!validated.ok) return res.status(400).json({ error: validated.reason });

  const quality = String(req.body?.quality || "192");
  if (!QUALITY_PRESETS.has(quality)) {
    return res.status(400).json({ error: "Choose 128, 192, or 320 kbps." });
  }

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    return res.status(503).json({ error: "The conversion engine isn't available right now. Please try again later." });
  }

  try {
    if (!(await checkRateLimit(clientKey(req)))) {
      return res.status(429).json({ error: "You've started several conversions recently. Please try again after the hourly limit resets." });
    }
  } catch (error) {
    console.error("Rate-limit database is unavailable:", error?.name || "unknown error");
    return res.status(503).json({ error: "The converter is temporarily unavailable. Please try again in a moment." });
  }

  const id = crypto.randomUUID();
  const directory = path.join(os.tmpdir(), "reeltone", id);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return res.status(500).json({ error: "Couldn't prepare the conversion. Please try again." });
  }

  const outputPath = path.join(directory, "audio.mp3");
  let child;
  let timedOut = false;
  let clientDisconnected = false;
  let stderrTail = "";
  let stdoutTail = "";
  const cleanup = () => fs.rm(directory, { recursive: true, force: true }, () => {});

  const timeout = setTimeout(() => {
    timedOut = true;
    if (child && typeof child.kill === "function") child.kill("SIGKILL");
  }, PROCESS_TIMEOUT_MS);
  timeout.unref?.();

  try {
    child = youtubeDl.exec(validated.url, {
      noConfig: true,
      noCacheDir: true,
      noWarnings: true,
      noPlaylist: true,
      newline: true,
      socketTimeout: 15,
      retries: 1,
      fragmentRetries: 1,
      matchFilter: `duration <= ${MAX_DURATION_SECONDS}`,
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: `${quality}K`,
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
      stdoutTail = (stdoutTail + chunk.toString()).slice(-2000);
    });

    // When a visitor cancels/closes the browser request, terminate the
    // expensive subprocess and remove temporary files.
    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        if (child && typeof child.kill === "function") child.kill("SIGTERM");
        clearTimeout(timeout);
        cleanup();
      }
    });

    await child;
    clearTimeout(timeout);

    if (clientDisconnected || res.destroyed) {
      cleanup();
      return;
    }

    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
      const diagnostic = safeExtractorDiagnostic(stderrTail + "\n" + stdoutTail, null);
      console.warn("ReelTone extractor produced no MP3:", diagnostic);
      cleanup();
      return res.status(502).json({
        error: safeConversionError({ stderr: stderrTail + "\n" + stdoutTail }, timedOut)
      });
    }

    res.status(200);
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": 'attachment; filename="reeltone.mp3"',
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(fs.statSync(outputPath).size)
    });

    try {
      await pipeline(fs.createReadStream(outputPath), res);
    } finally {
      cleanup();
    }
  } catch (error) {
    clearTimeout(timeout);
    cleanup();
    if (clientDisconnected || res.destroyed || res.headersSent) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    console.warn("ReelTone conversion failed:", error?.exitCode ?? error?.name ?? "unknown error", "|", safeExtractorDiagnostic(stderrTail, error));
    return res.status(502).json({
      error: safeConversionError({ stderr: stderrTail + "\n" + String(error?.stderr || error?.message || "") }, timedOut)
    });
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  console.error("Request failed:", err?.type || err?.name || "unknown error");
  res.status(err?.status || 500).json({ error: "Something went wrong. Please refresh and try again." });
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`ReelTone listening on port ${PORT}`));
}