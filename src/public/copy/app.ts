export {};

const continueBtn = document.getElementById("continueBtn") as HTMLButtonElement | null;
const checkDocBtn = document.getElementById("checkDocBtn") as HTMLButtonElement | null;
const scanOverlay = document.getElementById("scanOverlay") as HTMLElement | null;
const errorBanner = document.getElementById("errorBanner") as HTMLElement | null;
const errorText = document.getElementById("errorText") as HTMLElement | null;
const retryBtn = document.getElementById("retryBtn") as HTMLButtonElement | null;
const previewSection = document.getElementById("previewSection") as HTMLElement | null;
const previewFrame = document.getElementById("previewFrame") as HTMLIFrameElement | null;

let previewPath: string | null = null;

function showOverlay(show: boolean): void {
  if (!scanOverlay) return;
  if (show) {
    scanOverlay.classList.add("is-visible");
    scanOverlay.setAttribute("aria-hidden", "false");
  } else {
    scanOverlay.classList.remove("is-visible");
    scanOverlay.setAttribute("aria-hidden", "true");
  }
}

function showError(msg: string): void {
  if (errorBanner) errorBanner.style.display = "";
  if (errorText) errorText.textContent = msg;
  if (checkDocBtn) checkDocBtn.style.display = "";
  if (previewSection) previewSection.style.display = "none";
  if (continueBtn) continueBtn.style.display = "none";
}

function hideError(): void {
  if (errorBanner) errorBanner.style.display = "none";
}

function showPreview(filename: string): void {
  hideError();
  if (previewSection) previewSection.style.display = "";
  if (previewFrame) previewFrame.src = `/api/scan/preview/${encodeURIComponent(filename)}`;
  if (continueBtn) {
    continueBtn.style.display = "";
    continueBtn.disabled = false;
  }
  if (checkDocBtn) checkDocBtn.style.display = "none";
}

async function checkForDocument(): Promise<void> {
  hideError();
  showOverlay(true);
  if (checkDocBtn) checkDocBtn.disabled = true;

  try {
    const res = await fetch("/api/scan/preview", { method: "POST" });
    const data = (await res.json()) as {
      detected: boolean;
      previewPath?: string;
      error?: string;
    };

    showOverlay(false);

    if (data.detected && data.previewPath) {
      previewPath = data.previewPath;
      showPreview(data.previewPath);
    } else {
      showError(
        data.error ??
          "No document detected. Place your document face-down on the scanner glass and try again.",
      );
    }
  } catch {
    showOverlay(false);
    showError("Could not reach the scanner. Please try again.");
  } finally {
    if (checkDocBtn) checkDocBtn.disabled = false;
  }
}

checkDocBtn?.addEventListener("click", () => void checkForDocument());
retryBtn?.addEventListener("click", () => void checkForDocument());

continueBtn?.addEventListener("click", () => {
  sessionStorage.setItem("printbit.mode", "copy");
  sessionStorage.removeItem("printbit.sessionId");
  sessionStorage.removeItem("printbit.uploadedFile");
  if (previewPath) {
    sessionStorage.setItem("printbit.copyPreviewPath", previewPath);
  }
  window.location.href = "/config?mode=copy";
});
