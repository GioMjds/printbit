export {};

declare global {
  interface Window {
    uploadToken?: string;
    io?: () => SocketClient;
  }
}

interface SocketClient {
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

type UploadState = "session-loading" | "session-ready" | "session-error" | "uploading" | "all-done";
type ItemStatus  = "pending" | "uploading" | "done" | "error";

interface SessionResponse {
  sessionId: string;
  uploadUrl: string;
  status: "pending" | "uploaded";
}

interface UploadSuccessResponse {
  documentId: string;
  sessionId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

interface UploadErrorResponse {
  code?: string;
  error?: string;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const fileInput          = document.getElementById("fileInput")           as HTMLInputElement;
const dropZone           = document.getElementById("dropZone")            as HTMLDivElement;
const fileQueue          = document.getElementById("fileQueue")           as HTMLDivElement;
const uploadButton       = document.getElementById("uploadButton")        as HTMLButtonElement;
const uploadBtnLabel     = document.getElementById("uploadBtnLabel")      as HTMLSpanElement;
const statusBox          = document.getElementById("statusBox")           as HTMLDivElement;
const sessionMetaUpload  = document.getElementById("sessionMetaUpload")   as HTMLSpanElement;
const sessionDotUpload   = document.getElementById("sessionDotUpload")    as HTMLSpanElement;
const retrySessionButton = document.getElementById("retrySessionButton")  as HTMLButtonElement;
const uploadForm         = document.getElementById("uploadForm")          as HTMLFormElement;

// ── State ─────────────────────────────────────────────────────────────────────

const tokenFromPath = window.location.pathname.split("/")[2];
const token         = window.uploadToken || tokenFromPath;

let sessionId: string | null = null;
let appState: UploadState    = "session-loading";

/** Files staged for upload — keyed by a local id */
interface QueuedFile {
  id: string;
  file: File;
  status: ItemStatus;
  el: HTMLElement;
}

const queue: QueuedFile[] = [];
let nextId = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setAppState(s: UploadState): void {
  appState = s;
  const canUpload = s === "session-ready" && queue.some(q => q.status === "pending");
  uploadButton.disabled = !canUpload;
}

function setStatus(msg: string, cls: "info" | "ok" | "error" | ""): void {
  statusBox.textContent = msg;
  statusBox.className   = cls ? `status-box ${cls}` : "status-box";
}

function clearStatus(): void { setStatus("", ""); }

function setSessionUI(text: string, dot: "idle" | "active" | "error"): void {
  sessionMetaUpload.textContent = text;
  sessionDotUpload.classList.remove("active", "error");
  if (dot !== "idle") sessionDotUpload.classList.add(dot);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "file";
}

function mapError(r: UploadErrorResponse): string {
  switch (r.code) {
    case "DUPLICATE_FILE":    return "This file was already sent in this session.";
    case "INVALID_TOKEN":     return "Invalid token. Scan a fresh kiosk QR.";
    case "UNSUPPORTED_TYPE":  return "Unsupported file type.";
    case "FILE_TOO_LARGE":    return r.error ?? "File exceeds the 25 MB limit.";
    case "SESSION_NOT_FOUND": return "Session not found. Scan a fresh kiosk QR.";
    default:                  return r.error ?? "Upload failed.";
  }
}

// ── Queue item UI ─────────────────────────────────────────────────────────────

function createQueueItem(qf: QueuedFile): HTMLElement {
  const ext  = extOf(qf.file.name);
  const size = formatBytes(qf.file.size);

  const li = document.createElement("div");
  li.className    = "queue-item";
  li.dataset.qid  = qf.id;
  li.innerHTML = `
    <div class="queue-item__icon" data-ext="${ext}">${ext.toUpperCase()}</div>
    <div class="queue-item__info">
      <p class="queue-item__name" title="${escHtml(qf.file.name)}">${escHtml(qf.file.name)}</p>
      <span class="queue-item__size">${size}</span>
    </div>
    <span class="queue-item__status queue-item__status--pending">Pending</span>
    <button type="button" class="queue-item__remove" aria-label="Remove ${escHtml(qf.file.name)}">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414
        10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586
        10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
    </button>
    <div class="queue-item__progress" style="width:0%"></div>
  `;

  li.querySelector(".queue-item__remove")?.addEventListener("click", () => removeFromQueue(qf.id));
  return li;
}

function updateItemStatus(qf: QueuedFile, status: ItemStatus, labelOverride?: string): void {
  qf.status = status;
  const li   = qf.el;
  li.classList.remove("uploading", "done", "error");
  if (status !== "pending") li.classList.add(status);

  const badge = li.querySelector(".queue-item__status") as HTMLElement;
  badge.className = `queue-item__status queue-item__status--${status}`;
  badge.textContent = labelOverride ?? {
    pending:   "Pending",
    uploading: "Uploading…",
    done:      "✓ Sent",
    error:     "Failed",
  }[status];
}

function setItemProgress(qf: QueuedFile, pct: number): void {
  const bar = qf.el.querySelector(".queue-item__progress") as HTMLElement;
  if (bar) bar.style.width = `${pct}%`;
}

function removeFromQueue(id: string): void {
  const idx = queue.findIndex(q => q.id === id);
  if (idx === -1) return;
  const [qf] = queue.splice(idx, 1);
  qf.el.remove();
  refreshUploadBtn();
  if (queue.length === 0) clearStatus();
}

function escHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Add files to queue ────────────────────────────────────────────────────────

function addFilesToQueue(files: FileList | File[]): void {
  const arr = Array.from(files);
  for (const file of arr) {
    // Skip duplicates by name+size
    const isDupe = queue.some(q => q.file.name === file.name && q.file.size === file.size);
    if (isDupe) continue;

    const qf: QueuedFile = {
      id:     String(nextId++),
      file,
      status: "pending",
      el:     null as unknown as HTMLElement,
    };
    const el  = createQueueItem(qf);
    qf.el     = el;
    queue.push(qf);
    fileQueue.appendChild(el);
  }
  refreshUploadBtn();
  clearStatus();
}

function refreshUploadBtn(): void {
  const pendingCount = queue.filter(q => q.status === "pending").length;
  if (appState !== "session-ready" && appState !== "all-done") return;
  uploadButton.disabled = pendingCount === 0 || appState === "session-loading";
  uploadBtnLabel.textContent = pendingCount > 1
    ? `Send ${pendingCount} files to Kiosk`
    : "Send to Kiosk";
}

// ── Session init ──────────────────────────────────────────────────────────────

async function initSession(): Promise<void> {
  setAppState("session-loading");
  setSessionUI("Connecting to session…", "idle");
  setStatus("Connecting to kiosk session…", "info");

  if (!token) {
    setAppState("session-error");
    setSessionUI("No token — scan a fresh QR", "error");
    setStatus("No upload token found. Please scan a fresh kiosk QR.", "error");
    return;
  }

  try {
    const res = await fetch(`/api/wireless/sessions/by-token/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error("invalid");

    const session = (await res.json()) as SessionResponse;
    sessionId = session.sessionId;

    attachSocket(sessionId);
    setAppState("session-ready");
    setSessionUI(`Session ${sessionId.slice(0, 8)}…`, "active");
    clearStatus();
    refreshUploadBtn();
  } catch {
    setAppState("session-error");
    setSessionUI("Session unavailable", "error");
    setStatus("Could not reach the kiosk. Make sure you're on the kiosk Wi-Fi, then tap Retry.", "error");
  }
}

// ── Socket ────────────────────────────────────────────────────────────────────

function attachSocket(sid: string): void {
  if (typeof window.io !== "function") return;
  const socket = window.io();
  socket.emit("joinSession", sid);

  socket.on("UploadCompleted", (info: unknown) => {
    const name =
      typeof info === "object" && info !== null && "filename" in info &&
      typeof (info as { filename: unknown }).filename === "string"
        ? (info as { filename: string }).filename : "file";
    setStatus(`✓ ${name} received by kiosk.`, "ok");
  });

  socket.on("UploadFailed", () => {
    setStatus("Kiosk reported an upload error. Please retry.", "error");
  });
}

// ── Upload all pending files sequentially ─────────────────────────────────────

async function uploadPendingFiles(): Promise<void> {
  if (!sessionId) return;
  const pending = queue.filter(q => q.status === "pending");
  if (pending.length === 0) return;

  setAppState("uploading");
  uploadButton.disabled = true;
  clearStatus();

  let doneCount  = 0;
  let errorCount = 0;

  for (const qf of pending) {
    updateItemStatus(qf, "uploading");
    setItemProgress(qf, 20);

    const formData = new FormData();
    formData.append("file", qf.file);

    try {
      // Use XHR for upload progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/wireless/sessions/${sessionId}/upload?token=${encodeURIComponent(token)}`);

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setItemProgress(qf, Math.round((e.loaded / e.total) * 90));
          }
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setItemProgress(qf, 100);
            updateItemStatus(qf, "done");
            doneCount++;
            resolve();
          } else {
            try {
              const errBody = JSON.parse(xhr.responseText) as UploadErrorResponse;
              updateItemStatus(qf, "error", mapError(errBody));
            } catch {
              updateItemStatus(qf, "error", "Upload failed");
            }
            errorCount++;
            resolve(); // continue with next file
          }
        });

        xhr.addEventListener("error", () => {
          updateItemStatus(qf, "error", "Network error");
          errorCount++;
          reject();
        });

        xhr.send(formData);
      }).catch(() => {/* already handled */});

    } catch {
      updateItemStatus(qf, "error", "Network error");
      errorCount++;
    }
  }

  // Final summary
  if (errorCount === 0 && doneCount > 0) {
    setStatus(
      `✓ ${doneCount} file${doneCount > 1 ? "s" : ""} sent successfully. You can continue at the kiosk.`,
      "ok"
    );
    setAppState("all-done");
  } else if (doneCount > 0 && errorCount > 0) {
    setStatus(
      `${doneCount} file${doneCount > 1 ? "s" : ""} sent, ${errorCount} failed. You can retry failed items.`,
      "info"
    );
    setAppState("session-ready");
    refreshUploadBtn();
  } else {
    setStatus("All uploads failed. Please check your connection and try again.", "error");
    setAppState("session-ready");
    refreshUploadBtn();
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

// The hidden <input> covers the full drop zone via `position:absolute; inset:0`,
// so every pointer click already natively activates it. Adding a JS click handler
// that calls fileInput.click() on top of that opens TWO file dialogs — the second
// one cancels the first, which is why the first selection was never received.
// No click handler needed here at all.

dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) {
    addFilesToQueue(fileInput.files);
    fileInput.value = ""; // reset so same files can be re-added after removal
  }
});

dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", ()  => { dropZone.classList.remove("drag-over"); });
dropZone.addEventListener("drop", (e: DragEvent) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer?.files.length) addFilesToQueue(e.dataTransfer.files);
});

retrySessionButton.addEventListener("click", () => void initSession());

uploadForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (appState !== "session-ready") return;
  void uploadPendingFiles();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

void initSession();