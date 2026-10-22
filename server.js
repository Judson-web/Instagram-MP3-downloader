"use strict";

const express = require("express");
const helmet = require("helmet");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const youtubeDl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const { neon } = require("@neondatabase/serverless");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_DURATION_SECONDS = 10 * 60;
const MAX_REQUESTS_PER_HOUR = 8;
const PROCESS_TIMEOUT_MS = 240 * 1000;
const QUALITY_PRESETS = new Set(["128", "192", "320"]);
const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com"
]);
const regularPostPath = /^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i;
const sharedPostPath = /^\/share\/reel\/[A-Za-z0-9_-]+\/?$/i;
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

  if (!regularPostPath.test(parsed.pathname) && !sharedPostPath.test(parsed.pathname)) {
    return { ok: false, reason: "That URL doesn't look like an Instagram Reel or video post link." };
  }

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

function safeConversionError(error, timedOut) {
  if (timedOut) return "This Reel took too long to process. Try a shorter Reel.";
  const message = String(error?.stderr || error?.message || "").toLowerCase();

  if (/duration|match-filter|longer than/.test(message)) {
    return "This video is longer than the 10-minute limit.";
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
    console.warn("ReelTone conversion failed:", error?.exitCode ?? error?.name ?? "unknown error");
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