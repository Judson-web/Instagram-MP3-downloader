"use strict";

type ApiError = {
  code?: string;
  title?: string;
  error?: string;
  message?: string;
  retryable?: boolean;
  category?: string;
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required UI element not found: ${id}`);
  return element as T;
};

(() => {
  const form = byId<HTMLFormElement>("convert-form");
  const urlInput = byId<HTMLInputElement>("reel-url");
  const inputWrap = byId<HTMLDivElement>("url-input-wrap");
  const urlHint = byId<HTMLParagraphElement>("url-hint");
  const qualityInput = byId<HTMLSelectElement>("quality");
  const pasteButton = byId<HTMLButtonElement>("paste-button");
  const convertButton = byId<HTMLButtonElement>("convert-button");
  const progressPanel = byId<HTMLElement>("progress-panel");
  const progressTitle = byId<HTMLElement>("progress-title");
  const progressSubtitle = byId<HTMLElement>("progress-subtitle");
  const progressPercent = byId<HTMLElement>("progress-percent");
  const progressFill = byId<HTMLSpanElement>("progress-fill");
  const progressTrack = byId<HTMLDivElement>("progress-track");
  const progressStep = byId<HTMLElement>("progress-step");
  const progressSpinner = byId<HTMLDivElement>("progress-spinner");
  const cancelButton = byId<HTMLButtonElement>("cancel-button");
  const resultPanel = byId<HTMLElement>("result-panel");
  const resultQuality = byId<HTMLElement>("result-quality");
  const downloadButton = byId<HTMLButtonElement>("download-button");
  const newConversionButton = byId<HTMLButtonElement>("new-conversion-button");
  const errorPanel = byId<HTMLElement>("error-panel");
  const errorTitle = byId<HTMLElement>("error-title");
  const errorMessage = byId<HTMLParagraphElement>("error-message");
  const errorCategory = byId<HTMLSpanElement>("error-category");
  const resultFilename = byId<HTMLElement>("result-filename");
  const resultAuthor = byId<HTMLElement>("result-author");
  const resultExpiry = byId<HTMLParagraphElement>("result-expiry");
  const retryButton = byId<HTMLButtonElement>("retry-button");

  const allowedHosts = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
  const regularPostPath = /^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i;
  const sharedPostPath = /^\/share\/reel\/[A-Za-z0-9_-]+\/?$/i;
  const DOWNLOAD_URL_TTL_MS = 10 * 60 * 1000;

  let busy = false;
  let abortController: AbortController | null = null;
  let progressTimer: number | null = null;
  let progressStartedAt = 0;
  let audioObjectUrl: string | null = null;
  let audioExpiresAt = 0;
  let audioExpiryTimer: number | null = null;
  let expiryCountdownTimer: number | null = null;
  let audioTitle = "";
  let audioAuthor = "";
  let audioDownloadName = "reeltone.mp3";
  let cancelRequested = false;

  function show(element, visible) {
    element.hidden = !visible;
  }

  function setBusy(value) {
    busy = value;
    urlInput.disabled = value;
    qualityInput.disabled = value;
    pasteButton.disabled = value;
    convertButton.disabled = value;
    cancelButton.disabled = !value;
    convertButton.querySelector(".button-label").textContent = value ? "Converting…" : "Convert to MP3";
  }

  function validateUrl(value) {
    let parsed;
    try {
      parsed = new URL(value.trim());
    } catch {
      return false;
    }
    return parsed.protocol === "https:" &&
      allowedHosts.has(parsed.hostname.toLowerCase()) &&
      !parsed.username &&
      !parsed.password &&
      (regularPostPath.test(parsed.pathname) || sharedPostPath.test(parsed.pathname));
  }

  function clearPanels() {
    show(progressPanel, false);
    show(resultPanel, false);
    show(errorPanel, false);
  }

  function stopProgress() {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = null;
    progressTrack.classList.remove("is-indeterminate");
    progressSpinner.style.display = "";
  }

  function revokeAudioUrl() {
    if (audioExpiryTimer !== null) window.clearTimeout(audioExpiryTimer);
    if (expiryCountdownTimer !== null) window.clearInterval(expiryCountdownTimer);
    audioExpiryTimer = null;
    expiryCountdownTimer = null;
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
    audioExpiresAt = 0;
    downloadButton.disabled = true;
  }

  function updateExpiryStatus() {
    if (!audioObjectUrl || audioExpiresAt === 0) return;

    const remainingMs = audioExpiresAt - Date.now();
    if (remainingMs <= 0) {
      revokeAudioUrl();
      resultExpiry.textContent = "This temporary download has expired. Convert the Reel again to create a fresh file.";
      return;
    }

    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
    const seconds = String(remainingSeconds % 60).padStart(2, "0");
    resultExpiry.textContent = `Download link expires in ${minutes}:${seconds}.`;
  }

  function showInputError(message) {
    inputWrap.classList.add("invalid");
    urlInput.setAttribute("aria-invalid", "true");
    urlHint.textContent = message;
    urlInput.focus();
  }

  function clearInputError() {
    inputWrap.classList.remove("invalid");
    urlInput.removeAttribute("aria-invalid");
    urlHint.textContent = "Works with public Reels and video post links.";
  }

  function showError(title: string, message: string, code = "CONVERSION_FAILED", category?: string) {
    stopProgress();
    form.hidden = false;
    show(progressPanel, false);
    show(resultPanel, false);
    show(errorPanel, true);
    errorTitle.textContent = title || "We couldn't convert that link.";
    errorMessage.textContent = message || "Double-check the URL and try again.";
    const labelByCode: Record<string, string> = {
      PRIVATE_REEL: "PRIVATE REEL",
      LOGIN_REQUIRED: "LOGIN REQUIRED",
      NO_PUBLIC_MEDIA: "NO PUBLIC MEDIA",
      REEL_UNAVAILABLE: "REEL UNAVAILABLE",
      INSTAGRAM_RATE_LIMITED: "SOURCE RATE LIMIT",
      RATE_LIMITED: "HOURLY LIMIT",
      VIDEO_TOO_LONG: "DURATION LIMIT",
      VIDEO_TOO_LARGE: "FILE SIZE LIMIT",
      DATABASE_UNAVAILABLE: "SERVICE STATUS",
      RESOLVER_UNAVAILABLE: "LOOKUP SERVICE",
      CONVERSION_TIMEOUT: "TIMED OUT",
      INVALID_URL: "INVALID LINK",
      INVALID_QUALITY: "INVALID QUALITY"
    };
    const categoryByCode: Record<string, string> = {
      PRIVATE_REEL: "private",
      LOGIN_REQUIRED: "private",
      NO_PUBLIC_MEDIA: "unavailable",
      REEL_UNAVAILABLE: "unavailable",
      INSTAGRAM_RATE_LIMITED: "rate-limit",
      RATE_LIMITED: "rate-limit",
      VIDEO_TOO_LONG: "limit",
      VIDEO_TOO_LARGE: "limit",
      DATABASE_UNAVAILABLE: "service",
      RESOLVER_UNAVAILABLE: "service",
      CONVERSION_TIMEOUT: "service",
      INVALID_URL: "input",
      INVALID_QUALITY: "input"
    };
    errorCategory.textContent = labelByCode[code] || "CONVERSION ISSUE";
    errorPanel.dataset.kind = categoryByCode[code] || category || "generic";
    setBusy(false);
  }

  function showApiError(payload: ApiError) {
    const code = payload.code || "CONVERSION_FAILED";
    showError(
      payload.title || "We couldn't convert that Reel",
      payload.error || payload.message || "Check that the Reel is publicly accessible, then try again.",
      code,
      payload.category
    );
  }

  function paintConvertingState() {
    const elapsed = (Date.now() - progressStartedAt) / 1000;
    let title = "Fetching your Reel…";
    let subtitle = "Connecting to the public video and preparing audio.";
    let step = "Fetching the Reel";

    if (elapsed >= 8) {
      title = "Extracting the soundtrack…";
      subtitle = "This can take a moment. Keep this tab open.";
      step = "Extracting audio";
    }
    if (elapsed >= 22) {
      title = "Finishing your MP3…";
      subtitle = "Encoding the audio at " + qualityInput.value + " kbps.";
      step = "Encoding MP3";
    }
    progressTitle.textContent = title;
    progressSubtitle.textContent = subtitle;
    progressStep.textContent = step;
    progressPercent.textContent = elapsed < 1 ? "START" : "WORKING";
    progressTrack.setAttribute("aria-valuetext", "Conversion in progress");
  }

  function startProgress() {
    progressStartedAt = Date.now();
    show(progressPanel, true);
    progressTrack.classList.add("is-indeterminate");
    progressFill.style.width = "";
    progressTitle.textContent = "Getting things ready…";
    progressSubtitle.textContent = "Connecting to the converter.";
    progressPercent.textContent = "START";
    progressTrack.removeAttribute("aria-valuenow");
    progressStep.textContent = "Fetching the Reel";
    progressSpinner.style.display = "";
    cancelRequested = false;
    progressTimer = window.setInterval(paintConvertingState, 900);
    paintConvertingState();
  }

  function finishSuccess(blob: Blob) {
    stopProgress();
    revokeAudioUrl();
    audioObjectUrl = URL.createObjectURL(blob);
    audioExpiresAt = Date.now() + DOWNLOAD_URL_TTL_MS;
    downloadButton.disabled = false;
    resultExpiry.textContent = "Download link expires in 10:00.";
    expiryCountdownTimer = window.setInterval(updateExpiryStatus, 1000);
    audioExpiryTimer = window.setTimeout(updateExpiryStatus, DOWNLOAD_URL_TTL_MS);
    show(progressPanel, false);
    show(errorPanel, false);
    show(resultPanel, true);
    form.hidden = true;
    resultQuality.textContent = "MP3 · " + qualityInput.value + " kbps · " + formatBytes(blob.size);
    resultFilename.textContent = audioTitle || "reeltone.mp3";
    resultAuthor.textContent = audioAuthor ? "by " + audioAuthor : "MP3 audio · ready to download";
    setBusy(false);
  }

  function makeDownloadName(title: string): string {
    const normalized = (title || "reeltone")
      .normalize("NFKD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70)
      .toLowerCase();
    return (normalized || "reeltone") + ".mp3";
  }

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "Audio file";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function readError(response: Response): Promise<ApiError> {
    const text = await response.text().catch(() => "");
    try {
      return JSON.parse(text) as ApiError;
    } catch {
      return {
        code: "CONVERSION_FAILED",
        title: response.status === 429 ? "Hourly conversion limit reached" : "The conversion service returned an unexpected response",
        error: "Please try again in a moment.",
        retryable: true,
        category: "service"
      };
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;

    clearPanels();
    clearInputError();
    revokeAudioUrl();

    const url = urlInput.value.trim();
    if (!url) {
      showInputError("Paste an Instagram Reel link to get started.");
      return;
    }
    if (!validateUrl(url)) {
      showInputError("That doesn't look like an Instagram Reel link. Paste a public Reel or video post URL.");
      return;
    }

    setBusy(true);
    abortController = new AbortController();
    startProgress();

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg, application/json" },
        body: JSON.stringify({ url, quality: qualityInput.value }),
        signal: abortController.signal
      });

      if (!response.ok) {
        const failure = await readError(response);
        showApiError(failure);
        return;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("audio/")) {
        const failure = await readError(response);
        showApiError(failure);
        return;
      }

      const encodedTitle = response.headers.get("X-ReelTone-Title");
      const encodedAuthor = response.headers.get("X-ReelTone-Author");
      audioTitle = encodedTitle ? decodeURIComponent(encodedTitle) : "";
      audioAuthor = encodedAuthor ? decodeURIComponent(encodedAuthor) : "";
      audioDownloadName = makeDownloadName(audioTitle);
      const blob = await response.blob();
      if (!blob.size) {
        showError("The MP3 was empty", "Try another public Reel link.", "CONVERSION_FAILED");
        return;
      }
      finishSuccess(blob);
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (cancelRequested) {
          showError("Conversion cancelled", "No problem. Paste a Reel link whenever you're ready.");
        }
        return;
      }
      showError("Couldn't reach the converter", "Check your connection and try again in a moment.");
    } finally {
      abortController = null;
      stopProgress();
      if (!busy || cancelRequested) setBusy(false);
    }
  });

  pasteButton.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error("Clipboard unavailable");
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        urlInput.value = text.trim();
        clearInputError();
        urlInput.focus();
        pasteButton.textContent = "Pasted ✓";
        window.setTimeout(() => { pasteButton.textContent = "Paste"; }, 1300);
      } else {
        urlInput.focus();
      }
    } catch {
      urlHint.textContent = "Tap the field, then paste your Reel link.";
      urlInput.focus();
    }
  });

  urlInput.addEventListener("input", clearInputError);

  cancelButton.addEventListener("click", () => {
    if (!busy || !abortController) return;
    cancelRequested = true;
    stopProgress();
    abortController.abort();
  });

  downloadButton.addEventListener("click", () => {
    if (!audioObjectUrl || Date.now() >= audioExpiresAt) {
      updateExpiryStatus();
      showError("This download has expired", "Temporary download links expire after 10 minutes. Convert the Reel again to create a fresh download.");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = audioObjectUrl;
    anchor.download = audioDownloadName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });

  function resetForAnother() {
    stopProgress();
    revokeAudioUrl();
    abortController?.abort();
    abortController = null;
    cancelRequested = false;
    form.hidden = false;
    form.reset();
    qualityInput.value = "192";
    audioTitle = "";
    audioAuthor = "";
    audioDownloadName = "reeltone.mp3";
    setBusy(false);
    clearPanels();
    clearInputError();
    urlInput.focus();
  }

  newConversionButton.addEventListener("click", resetForAnother);
  retryButton.addEventListener("click", () => {
    show(errorPanel, false);
    clearInputError();
    urlInput.focus();
  });

  window.addEventListener("pagehide", revokeAudioUrl);
  window.addEventListener("pageshow", () => {
    if (!abortController) setBusy(false);
  });
})();