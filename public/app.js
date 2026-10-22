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

  let currentJobId = null;
  let pollTimer = null;
  let networkFailures = 0;
  let busy = false;

  function show(element, visible) {
    element.hidden = !visible;
  }

  function setBusy(value) {
    busy = value;
    urlInput.disabled = value;
    qualityInput.disabled = value;
    pasteButton.disabled = value;
    convertButton.disabled = value;
    convertButton.querySelector(".button-label").textContent = value ? "Converting…" : "Convert to MP3";
    if (value) {
      inputWrap.classList.remove("invalid");
      urlInput.removeAttribute("aria-invalid");
    }
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
    stopPolling();
    show(progressPanel, false);
    show(resultPanel, false);
    show(errorPanel, true);
    errorTitle.textContent = title || "We couldn't convert that link.";
    errorMessage.textContent = message || "Double-check the URL and try again.";
    progressSpinner.style.display = "";
    setBusy(false);
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function paintProgress(job) {
    const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
    progressPercent.textContent = progress + "%";
    progressFill.style.width = progress + "%";
    progressTrack.setAttribute("aria-valuenow", String(progress));
    progressTitle.textContent = job.message || "Working on your MP3…";
    progressSubtitle.textContent = job.status === "converting"
      ? "Finishing the audio at your chosen quality."
      : "Keep this tab open while your MP3 is prepared.";
    progressStep.textContent = job.status === "converting" ? "Encoding MP3" : "Fetching the Reel";
  }

  function finishSuccess() {
    stopPolling();
    show(progressPanel, false);
    show(errorPanel, false);
    show(resultPanel, true);
    form.hidden = true;
    resultQuality.textContent = "MP3 · " + qualityInput.value + " kbps";
    progressSpinner.style.display = "";
    setBusy(false);
  }

  async function pollJob() {
    if (!currentJobId) return;
    try {
      const response = await fetch("/api/jobs/" + encodeURIComponent(currentJobId), {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        currentJobId = null;
        showError("Conversion expired", data.error || "The conversion couldn't be found. Try again.");
        return;
      }

      networkFailures = 0;
      paintProgress(data);

      if (data.status === "completed") {
        finishSuccess();
        return;
      }
      if (data.status === "failed") {
        showError("That Reel couldn't be converted", data.error || "Try another public Reel link.");
        return;
      }
      if (data.status === "cancelled") {
        currentJobId = null;
        show(progressPanel, false);
        setBusy(false);
        return;
      }
      pollTimer = window.setTimeout(pollJob, 1400);
    } catch {
      networkFailures += 1;
      if (networkFailures >= 5) {
        showError("Connection interrupted", "We lost contact with the converter. Check your connection and try the link again.");
        return;
      }
      progressSubtitle.textContent = "Reconnecting to the converter…";
      pollTimer = window.setTimeout(pollJob, 2000);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    clearPanels();
    clearInputError();

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
    show(progressPanel, true);
    progressTitle.textContent = "Getting things ready…";
    progressSubtitle.textContent = "Connecting to the converter.";
    progressPercent.textContent = "3%";
    progressFill.style.width = "3%";
    progressTrack.setAttribute("aria-valuenow", "3");
    progressStep.textContent = "Fetching the Reel";
    cancelButton.disabled = false;
    networkFailures = 0;

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url, quality: qualityInput.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        show(progressPanel, false);
        setBusy(false);
        showError("Ready for another try", data.error || "The converter couldn't start. Please try again.");
        return;
      }
      currentJobId = data.jobId;
      pollJob();
    } catch {
      show(progressPanel, false);
      setBusy(false);
      showError("Couldn't reach the converter", "Check your connection and try again in a moment.");
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

  cancelButton.addEventListener("click", async () => {
    stopPolling();
    const id = currentJobId;
    currentJobId = null;
    cancelButton.disabled = true;
    if (id) {
      try {
        await fetch("/api/jobs/" + encodeURIComponent(id), { method: "DELETE" });
      } catch {
        // The UI still returns to its idle state if the connection drops.
      }
    }
    show(progressPanel, false);
    setBusy(false);
    cancelButton.disabled = false;
    showError("Conversion cancelled", "No problem. Paste a Reel link whenever you're ready.");
    urlInput.focus();
  });

  downloadButton.addEventListener("click", () => {
    if (!currentJobId) {
      showError("This MP3 has expired", "Run the conversion again to create a fresh download.");
      return;
    }
    const originalText = downloadButton.lastChild;
    downloadButton.disabled = true;
    downloadButton.setAttribute("aria-busy", "true");
    window.location.assign("/api/jobs/" + encodeURIComponent(currentJobId) + "/download");
    downloadButton.querySelector("svg");
    window.setTimeout(() => {
      downloadButton.disabled = false;
      downloadButton.removeAttribute("aria-busy");
      if (originalText && originalText.nodeType === Node.TEXT_NODE) originalText.textContent = "Download MP3";
    }, 1800);
  });

  function resetForAnother() {
    stopPolling();
    currentJobId = null;
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

  // Ensure service health failures never leave the button disabled.
  window.addEventListener("pageshow", () => {
    if (!currentJobId) setBusy(false);
  });
})();