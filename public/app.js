"use strict";

(() => {
  const form = document.getElementById("convert-form");
  const urlInput = document.getElementById("reel-url");
  const inputWrap = document.getElementById("url-input-wrap");
  const urlHint = document.getElementById("url-hint");
  const qualityInput = document.getElementById("quality");
  const pasteButton = document.getElementById("paste-button");
  const convertButton = document.getElementById("convert-button");
  const progressPanel = document.getElementById("progress-panel");
  const progressTitle = document.getElementById("progress-title");
  const progressSubtitle = document.getElementById("progress-subtitle");
  const progressPercent = document.getElementById("progress-percent");
  const progressFill = document.getElementById("progress-fill");
  const progressTrack = document.getElementById("progress-track");
  const progressStep = document.getElementById("progress-step");
  const progressSpinner = document.getElementById("progress-spinner");
  const cancelButton = document.getElementById("cancel-button");
  const resultPanel = document.getElementById("result-panel");
  const resultQuality = document.getElementById("result-quality");
  const downloadButton = document.getElementById("download-button");
  const newConversionButton = document.getElementById("new-conversion-button");
  const errorPanel = document.getElementById("error-panel");
  const errorTitle = document.getElementById("error-title");
  const errorMessage = document.getElementById("error-message");
  const retryButton = document.getElementById("retry-button");

  const allowedHosts = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
  const regularPostPath = /^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/i;
  const sharedPostPath = /^\/share\/reel\/[A-Za-z0-9_-]+\/?$/i;

  let busy = false;
  let abortController = null;
  let progressTimer = null;
  let progressStartedAt = 0;
  let audioObjectUrl = null;
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
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
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

  function showError(title, message) {
    stopProgress();
    show(progressPanel, false);
    show(resultPanel, false);
    show(errorPanel, true);
    errorTitle.textContent = title || "We couldn't convert that link.";
    errorMessage.textContent = message || "Double-check the URL and try again.";
    setBusy(false);
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

  function finishSuccess(blob) {
    stopProgress();
    revokeAudioUrl();
    audioObjectUrl = URL.createObjectURL(blob);
    show(progressPanel, false);
    show(errorPanel, false);
    show(resultPanel, true);
    form.hidden = true;
    resultQuality.textContent = "MP3 · " + qualityInput.value + " kbps · " + formatBytes(blob.size);
    setBusy(false);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "Audio file";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function readError(response) {
    const text = await response.text().catch(() => "");
    try {
      const data = JSON.parse(text);
      return data.error || "The conversion couldn't be completed.";
    } catch {
      return "The conversion service returned an unexpected response. Please try again.";
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
        const message = await readError(response);
        showError("That Reel couldn't be converted", message);
        return;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("audio/")) {
        const message = await readError(response);
        showError("Unexpected conversion response", message);
        return;
      }

      const blob = await response.blob();
      if (!blob.size) {
        showError("The MP3 was empty", "Try another public Reel link.");
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
    if (!audioObjectUrl) {
      showError("This MP3 is no longer available", "Convert the Reel again to create a fresh download.");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = audioObjectUrl;
    anchor.download = "reeltone.mp3";
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