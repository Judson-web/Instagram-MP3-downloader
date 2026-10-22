"use strict";

const express = require("express");
const helmet = require("helmet");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_DURATION_SECONDS = 10 * 60;
const MAX_ACTIVE_JOBS = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS || 1));
const MAX_REQUESTS_PER_HOUR = 8;
const JOB_TTL_MS = 15 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 3 * 60 * 1000;
const QUALITY_PRESETS = new Set(["128", "192", "320"]);
const jobs = new Map();
const requestsByIp = new Map();
const activeByIp = new Map();

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

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { maxAge: "1h", etag: true }));

function clientKey(req) {
  return String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100);
}

function isActive(job) {
  return job && ["queued", "downloading", "converting"].includes(job.status);
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
  const allowedHosts = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
  if (parsed.protocol !== "https:" || !allowedHosts.has(hostname) || parsed.username || parsed.password) {
    return { ok: false, reason: "Use a public Instagram Reel link that starts with https://www.instagram.com/." };
  }

  const reelPath = parsed.pathname.match(/^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i);
  const sharedReelPath = parsed.pathname.match(/^\/share\/reel\/[A-Za-z0-9_-]+\/?$/i);
  if (!reelPath && !sharedReelPath) {
    return { ok: false, reason: "That URL doesn't look like an Instagram Reel or video post link." };
  }

  // Tracking query parameters are not required for public post URLs.
  parsed.search = "";
  parsed.hash = "";
  parsed.hostname = "www.instagram.com";
  return { ok: true, url: parsed.toString() };
}

function publicError(stderr, exitCode, timedOut) {
  if (timedOut) return "This Reel took too long to process. Try again in a moment.";
  const message = String(stderr || "").toLowerCase();

  if (/duration|match-filter|longer than/.test(message)) {
    return "This video is longer than the 10-minute limit.";
  }
  if (/login|required|private|401|403|challenge|checkpoint|rate.?limit|429|not authorized/.test(message)) {
    return "Instagram couldn't provide this media publicly. The Reel may be private, login-gated, unavailable, or temporarily restricted.";
  }
  if (/unsupported url|does not exist|not available|404|no video|could not find/.test(message)) {
    return "We couldn't find a playable video at that link. Check the URL and try again.";
  }
  if (exitCode === 0) return "Audio extraction finished without a downloadable MP3. Please try again.";
  return "Couldn't extract audio from that link. Make sure the Reel is public, then try again.";
}

function statusMessage(job) {
  if (job.status === "queued") return "Getting things ready…";
  if (job.status === "downloading") return "Fetching the Reel audio…";
  if (job.status === "converting") return "Turning it into an MP3…";
  if (job.status === "completed") return "Your MP3 is ready.";
  if (job.status === "cancelled") return "Conversion cancelled.";
  return "Conversion couldn't be completed.";
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: statusMessage(job),
    error: job.error || null
  };
}

function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.process && isActive(job)) {
    job.cancelled = true;
    job.process.kill("SIGTERM");
  }
  fs.rm(job.directory, { recursive: true, force: true }, () => {});
  jobs.delete(id);
}

function expireLater(job) {
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = setTimeout(() => removeJob(job.id), JOB_TTL_MS);
  job.expiryTimer.unref?.();
}

function applyRateLimit(ip) {
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

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "reeltone", maxDurationSeconds: MAX_DURATION_SECONDS });
});

app.post("/api/convert", (req, res) => {
  const ip = clientKey(req);
  const validated = validateInstagramUrl(req.body?.url);
  if (!validated.ok) return res.status(400).json({ error: validated.reason });

  const quality = String(req.body?.quality || "192");
  if (!QUALITY_PRESETS.has(quality)) {
    return res.status(400).json({ error: "Choose 128, 192, or 320 kbps." });
  }

  if (!applyRateLimit(ip)) {
    return res.status(429).json({ error: "You've started several conversions recently. Please try again in about an hour." });
  }
  if (activeByIp.has(ip)) {
    return res.status(429).json({ error: "You already have a conversion running. Finish or cancel it before starting another." });
  }

  const activeCount = [...jobs.values()].filter((job) => isActive(job)).length;
  if (activeCount >= MAX_ACTIVE_JOBS) {
    res.set("Retry-After", "20");
    return res.status(503).json({ error: "The converter is busy right now. Please try again shortly." });
  }

  const id = crypto.randomUUID();
  const directory = path.join(os.tmpdir(), "reeltone", id);
  fs.mkdirSync(directory, { recursive: true });
  const job = {
    id,
    owner: ip,
    directory,
    url: validated.url,
    quality,
    status: "queued",
    progress: 3,
    error: null,
    process: null,
    stderrTail: "",
    stdoutTail: "",
    cancelled: false,
    createdAt: Date.now(),
    filePath: null,
    expiryTimer: null
  };
  jobs.set(id, job);
  activeByIp.set(ip, id);

  const outputTemplate = path.join(directory, "audio.%(ext)s");
  const args = [
    "--no-config",
    "--no-cache-dir",
    "--no-warnings",
    "--no-playlist",
    "--newline",
    "--progress",
    "--socket-timeout", "15",
    "--retries", "1",
    "--fragment-retries", "1",
    "--match-filter", `duration <= ${MAX_DURATION_SECONDS}`,
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", `${quality}K`,
    "--output", outputTemplate,
    "--print", "after_move:filepath",
    validated.url
  ];

  try {
    const child = spawn(process.env.YT_DLP_PATH || "yt-dlp", args, {
      cwd: directory,
      env: { ...process.env, HOME: directory },
      stdio: ["ignore", "pipe", "pipe"]
    });
    job.process = child;
    job.status = "downloading";

    let progressBuffer = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (job.process && isActive(job)) job.process.kill("SIGTERM");
    }, PROCESS_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      const data = chunk.toString();
      job.stdoutTail = (job.stdoutTail + data).slice(-4000);
    });

    child.stderr.on("data", (chunk) => {
      const data = chunk.toString();
      job.stderrTail = (job.stderrTail + data).slice(-8000);
      progressBuffer = (progressBuffer + data).slice(-2000);

      const match = progressBuffer.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
      if (match && job.status === "downloading") {
        job.progress = Math.min(82, Math.max(job.progress, Math.round(8 + Number(match[1]) * 0.72)));
      }
      if (/\[ExtractAudio\]|ffmpeg/i.test(data) && isActive(job)) {
        job.status = "converting";
        job.progress = Math.max(job.progress, 88);
      }
    });

    child.on("error", () => {
      clearTimeout(timeout);
      if (job.status === "cancelled" || job.cancelled) return;
      job.status = "failed";
      job.error = "The audio conversion tool couldn't start. Please try again later.";
      activeByIp.delete(ip);
      expireLater(job);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (job.status === "cancelled" || job.cancelled) {
        activeByIp.delete(ip);
        expireLater(job);
        return;
      }

      if (timedOut) {
        job.status = "failed";
        job.error = publicError(job.stderrTail, code, true);
      } else if (code === 0) {
        const expected = path.join(directory, "audio.mp3");
        const printed = job.stdoutTail.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".mp3")).pop();
        const candidate = printed && path.resolve(printed).startsWith(path.resolve(directory) + path.sep)
          ? path.resolve(printed)
          : expected;

        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          job.filePath = candidate;
          job.status = "completed";
          job.progress = 100;
        } else {
          job.status = "failed";
          job.error = publicError(job.stderrTail, code, false);
        }
      } else {
        job.status = "failed";
        job.error = publicError(job.stderrTail, code, false);
      }

      job.process = null;
      activeByIp.delete(ip);
      // Never log a submitted URL or raw extractor output.
      if (job.status === "failed") console.warn("ReelTone conversion failed (exit code:", code, ").");
      expireLater(job);
    });
  } catch {
    activeByIp.delete(ip);
    job.status = "failed";
    job.error = "The conversion service couldn't start. Please try again.";
    expireLater(job);
  }

  return res.status(202).json({ jobId: id });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== clientKey(req)) return res.status(404).json({ error: "This conversion has expired or could not be found." });
  res.set("Cache-Control", "no-store");
  return res.json(publicJob(job));
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== clientKey(req) || job.status !== "completed" || !job.filePath) {
    return res.status(404).json({ error: "This MP3 is no longer available. Run the conversion again." });
  }
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  return res.download(job.filePath, "reeltone.mp3", (error) => {
    if (error && !res.headersSent) res.status(500).json({ error: "The MP3 couldn't be downloaded. Please try again." });
  });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== clientKey(req)) return res.status(404).json({ error: "This conversion has expired or could not be found." });

  if (isActive(job)) {
    job.cancelled = true;
    job.status = "cancelled";
    job.error = null;
    if (job.process) job.process.kill("SIGTERM");
    activeByIp.delete(job.owner);
    expireLater(job);
  }
  return res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  console.error("Request failed:", err?.type || err?.name || "unknown error");
  res.status(err?.status || 500).json({ error: "Something went wrong. Please refresh and try again." });
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.expiryTimer && now - job.createdAt > JOB_TTL_MS) removeJob(id);
  }
  for (const [ip, entries] of requestsByIp) {
    const recent = entries.filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length) requestsByIp.set(ip, recent);
    else requestsByIp.delete(ip);
  }
}, 60 * 1000);
cleanup.unref?.();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ReelTone listening on port ${PORT}`);
});