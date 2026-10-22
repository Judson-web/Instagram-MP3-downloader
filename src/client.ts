"use strict";

type ApiError = {
  code?: string;
  title?: string;
  error?: string;
  message?: string;
  retryable?: boolean;
  category?: string;
  retryAfterSeconds?: number;
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
  const qualityInput = byId<HTMLInputElement>("quality");
  const qualityPicker = byId<HTMLDivElement>("quality-select");
  const qualityTrigger = byId<HTMLButtonElement>("quality-trigger");
  const qualityCurrent = byId<HTMLSpanElement>("quality-current");
  const qualityOptions = byId<HTMLDivElement>("quality-options");
  const qualityOptionButtons = Array.from(qualityOptions.querySelectorAll<HTMLButtonElement>("[data-quality]"));
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
  const themeToggle = byId<HTMLButtonElement>("theme-toggle");
  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

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

  function syncQualityOptions() {
    qualityOptionButtons.forEach((option) => {
      const selected = option.dataset.quality === qualityInput.value;
      option.setAttribute("aria-selected", String(selected));
      option.tabIndex = -1;
    });
    qualityCurrent.textContent = qualityInput.value + " kbps";
    qualityTrigger.setAttribute("aria-label", "Audio quality: " + qualityInput.value + " kbps");
  }

  function closeQualityList(restoreFocus = false) {
    qualityOptions.hidden = true;
    qualityTrigger.setAttribute("aria-expanded", "false");
    qualityPicker.classList.remove("is-open");
    if (restoreFocus) qualityTrigger.focus();
  }

  function openQualityList(focusSelected = true) {
    if (busy) return;
    const pickerBounds = qualityPicker.getBoundingClientRect();
    const spaceAbove = pickerBounds.top;
    const spaceBelow = window.innerHeight - pickerBounds.bottom;
    const minimumMenuSpace = Math.min(160, window.innerHeight * 0.3);
    qualityPicker.classList.toggle("opens-up", spaceAbove >= minimumMenuSpace || spaceAbove >= spaceBelow);
    qualityOptions.hidden = false;
    qualityTrigger.setAttribute("aria-expanded", "true");
    qualityPicker.classList.add("is-open");
    const selected = qualityOptionButtons.find((option) => option.dataset.quality === qualityInput.value);
    (focusSelected ? selected : qualityOptionButtons[0])?.focus();
  }

  function chooseQuality(value: string) {
    if (!["128", "192", "256", "320"].includes(value)) return;
    qualityInput.value = value;
    syncQualityOptions();
    closeQualityList(false);
    qualityTrigger.focus();
  }

  type Theme = "light" | "dark";
  const themeStorageKey = "reeltone-theme";

  function applyTheme(theme: Theme, persist = true) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    themeToggle.title = isDark ? "Switch to light mode" : "Switch to dark mode";
    themeToggle.innerHTML = (isDark
      ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.3 15.1A8.6 8.6 0 0 1 8.9 3.7 8.7 8.7 0 1 0 20.3 15.1Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>')
      + '<span id="theme-toggle-label">' + (isDark ? "Light mode" : "Dark mode") + "</span>";
    if (themeColorMeta) themeColorMeta.content = isDark ? "#171816" : "#f7f6f2";
    if (persist) {
      try { window.localStorage.setItem(themeStorageKey, theme); } catch { /* Storage may be disabled. */ }
    }
  }

  function setBusy(value) {
    busy = value;
    urlInput.disabled = value;
    qualityInput.disabled = value;
    qualityTrigger.disabled = value;
    qualityOptionButtons.forEach((option) => { option.disabled = value; });
    if (value) closeQualityList(false);
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
      RESOLVER_RATE_LIMITED: "LOOKUP RATE LIMIT",
      PROVIDER_RATE_LIMITED: "PROVIDER RATE LIMIT",
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
      RESOLVER_RATE_LIMITED: "rate-limit",
      PROVIDER_RATE_LIMITED: "rate-limit",
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

  let retryCountdownInterval: number | null = null;
  let retryButtonDefaultLabel = retryButton.textContent?.trim() || "Try again";

  function clearRetryCountdown() {
    if (retryCountdownInterval !== null) window.clearInterval(retryCountdownInterval);
    retryCountdownInterval = null;
    retryButton.disabled = false;
    retryButton.textContent = retryButtonDefaultLabel;
  }

  function startRetryCountdown(seconds: number) {
    clearRetryCountdown();
    const endAt = Date.now() + Math.max(1, seconds) * 1000;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      if (remaining <= 0) {
        clearRetryCountdown();
        return;
      }
      const minutes = Math.floor(remaining / 60);
      const secs = remaining % 60;
      retryButton.disabled = true;
      retryButton.textContent = minutes > 0
        ? "Try again in " + minutes + "m " + String(secs).padStart(2, "0") + "s"
        : "Try again in " + secs + "s";
    };
    update();
    retryCountdownInterval = window.setInterval(update, 1000);
  }

  function showApiError(payload: ApiError) {
    const code = payload.code || "CONVERSION_FAILED";
    clearRetryCountdown();
    const cooldownCodes = ["INSTAGRAM_RATE_LIMITED", "RESOLVER_RATE_LIMITED", "PROVIDER_RATE_LIMITED"];
    let message = payload.error || payload.message || "Check that the Reel is publicly accessible, then try again.";
    if (cooldownCodes.includes(code) && Number(payload.retryAfterSeconds) > 0) {
      const seconds = Math.max(1, Math.ceil(Number(payload.retryAfterSeconds)));
      const minutes = Math.ceil(seconds / 60);
      message += " Retry is paused for about " + (minutes <= 1 ? "one minute." : minutes + " minutes.") + " The retry button will unlock when the cooldown ends.";
      startRetryCountdown(seconds);
    }
    showError(
      payload.title || "We couldn't convert that Reel",
      message,
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

  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return;
    event.preventDefault();
  });

  syncQualityOptions();
  qualityTrigger.addEventListener("click", () => {
    if (qualityOptions.hidden) openQualityList();
    else closeQualityList(false);
  });
  qualityOptionButtons.forEach((option) => {
    option.addEventListener("click", () => chooseQuality(option.dataset.quality || ""));
    option.addEventListener("keydown", (event: KeyboardEvent) => {
      const index = qualityOptionButtons.indexOf(option);
      let next = index;
      if (event.key === "ArrowDown") next = (index + 1) % qualityOptionButtons.length;
      else if (event.key === "ArrowUp") next = (index - 1 + qualityOptionButtons.length) % qualityOptionButtons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = qualityOptionButtons.length - 1;
      else if (event.key === "Escape") { event.preventDefault(); closeQualityList(true); return; }
      else if (event.key === "Tab") { closeQualityList(false); return; }
      else return;
      event.preventDefault();
      qualityOptionButtons[next]?.focus();
    });
  });
  qualityTrigger.addEventListener("keydown", (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (qualityOptions.hidden) openQualityList(event.key !== "ArrowDown");
      else qualityOptionButtons[0]?.focus();
    } else if (event.key === "Escape") closeQualityList(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!qualityPicker.contains(event.target as Node)) closeQualityList(false);
  });
  document.addEventListener("focusin", (event) => {
    if (!qualityPicker.contains(event.target as Node)) closeQualityList(false);
  });

  const savedTheme = (() => {
    try {
      const saved = window.localStorage.getItem(themeStorageKey);
      if (saved === "light" || saved === "dark") return saved as Theme;
    } catch { /* Storage may be disabled. */ }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  })();
  applyTheme(savedTheme, false);
  themeToggle.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
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
    syncQualityOptions();
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
    if (retryButton.disabled) return;
    show(errorPanel, false);
    clearInputError();
    if (urlInput.value.trim()) form.requestSubmit();
    else urlInput.focus();
  });

  window.addEventListener("pagehide", revokeAudioUrl);
  window.addEventListener("pageshow", () => {
    if (!abortController) setBusy(false);
  });
})();