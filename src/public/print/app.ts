import QRCode from "qrcode";

// ── Types ─────────────────────────────────────────────────────────────────────

type UploadedFile = {
  filename: string;
  size?: number; // bytes, optional
  sizeBytes?: number;
};

type SessionResponse = {
  sessionId: string;
  token: string;
  status: "pending" | "uploaded";
  uploadUrl: string;
  /** Single document (legacy) */
  document?: UploadedFile;
  /** Multiple documents (preferred) */
  documents?: UploadedFile[];
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const uploadLink = document.getElementById(
  "uploadLink",
) as HTMLAnchorElement | null;
const openUploadBtn = document.getElementById(
  "openUploadBtn",
) as HTMLButtonElement | null;
const refreshSessionBtn = document.getElementById(
  "refreshSessionBtn",
) as HTMLButtonElement | null;
const continueBtn = document.getElementById(
  "continueBtn",
) as HTMLButtonElement | null;
const sessionText = document.getElementById(
  "sessionText",
) as HTMLElement | null;
const sessionDot = document.getElementById("sessionDot") as HTMLElement | null;
const uploadQrCanvas = document.getElementById(
  "uploadQrCanvas",
) as HTMLCanvasElement | null;
const filesEmpty = document.getElementById("filesEmpty") as HTMLElement | null;
const fileList = document.getElementById("fileList") as HTMLUListElement | null;
const filesCount = document.getElementById("filesCount") as HTMLElement | null;
const footerHint = document.getElementById("footerHint") as HTMLElement | null;

// ── State ─────────────────────────────────────────────────────────────────────

let activeSessionId = "";
let pollHandle: number | null = null;
let selectedFilename = "";
let knownFiles = new Set<string>();
let attachedSessionId: string | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setSessionText(text: string): void {
  if (sessionText) sessionText.textContent = text;
}

function setSessionActive(active: boolean): void {
  sessionDot?.classList.toggle("active", active);
}

function setFilesCount(n: number): void {
  if (!filesCount) return;
  filesCount.textContent = n === 1 ? "1 file" : `${n} files`;
  filesCount.classList.toggle("has-files", n > 0);
}

/** Map a filename extension to a SVG sprite id */
function iconIdForFile(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "icon-pdf";
  if (ext === "doc" || ext === "docx") return "icon-doc";
  if (ext === "xls" || ext === "xlsx") return "icon-xls";
  if (ext === "ppt" || ext === "pptx") return "icon-ppt";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff"].includes(ext))
    return "icon-img";
  return "icon-txt";
}

/** Format bytes → human-readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKey(file: UploadedFile): string {
  const bytes = file.size ?? file.sizeBytes ?? -1;
  return `${file.filename}::${bytes}`;
}

// ── File list rendering ───────────────────────────────────────────────────────

function selectFile(filename: string): void {
  selectedFilename = filename;

  // Update aria-selected on all items
  fileList?.querySelectorAll(".file-item").forEach((el) => {
    const selected = (el as HTMLElement).dataset.filename === filename;
    el.setAttribute("aria-selected", String(selected));
  });

  // Enable continue button
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.setAttribute("aria-disabled", "false");
  }

  if (footerHint) {
    footerHint.textContent = `"${filename}" selected.`;
    footerHint.classList.add("ready");
  }
}

function addFileToList(file: UploadedFile): void {
  if (!fileList) return;
  const key = fileKey(file);
  if (knownFiles.has(key)) return;
  knownFiles.add(key);

  const ext = file.filename.split(".").pop()?.toUpperCase() ?? "FILE";
  const icon = iconIdForFile(file.filename);

  const li = document.createElement("li");
  li.className = "file-item";
  li.role = "option";
  li.setAttribute("aria-selected", "false");
  li.dataset.filename = file.filename;

  li.innerHTML = `
    <div class="file-item__icon" aria-hidden="true">
      <svg><use href="#${icon}"/></svg>
    </div>
    <div class="file-item__info">
      <p class="file-item__name">${escapeHtml(file.filename)}</p>
      <div class="file-item__meta">
        <span class="file-item__ext">${escapeHtml(ext)}</span>
        ${file.size !== undefined ? `<span>${formatBytes(file.size)}</span>` : ""}
      </div>
    </div>
    <div class="file-item__radio" aria-hidden="true"></div>
  `;

  li.addEventListener("click", () => selectFile(file.filename));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectFile(file.filename);
    }
  });

  fileList.appendChild(li);
  const total = knownFiles.size;
  setFilesCount(total);

  // Show list, hide empty state
  filesEmpty?.classList.add("hidden");
  fileList.classList.remove("hidden");

  // Auto-select first file
  if (total === 1) selectFile(file.filename);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Session management ────────────────────────────────────────────────────────

function updateUploadLink(token: string): void {
  const href = `/upload/${encodeURIComponent(token)}`;
  const absoluteUrl = `${window.location.origin}${href}`;

  if (uploadLink) {
    uploadLink.href = href;
    uploadLink.textContent = absoluteUrl;
  }

  if (openUploadBtn) {
    openUploadBtn.onclick = () => window.open(href, "_blank");
  }

  if (uploadQrCanvas) {
    void QRCode.toCanvas(uploadQrCanvas, absoluteUrl, {
      width: 220,
      margin: 1,
      color: { dark: "#1a1a2e", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  }
}

async function createSession(): Promise<void> {
  if (pollHandle !== null) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }

  // Reset UI
  selectedFilename = "";
  knownFiles.clear();
  setSessionActive(false);
  setSessionText("Creating session…");
  setFilesCount(0);

  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.setAttribute("aria-disabled", "true");
  }
  if (footerHint) {
    footerHint.textContent = "Select a file above to continue.";
    footerHint.classList.remove("ready");
  }

  if (fileList) {
    fileList.innerHTML = "";
    fileList.classList.add("hidden");
  }
  if (filesEmpty) {
    filesEmpty.classList.remove("hidden");
  }

  const response = await fetch("/api/wireless/sessions");
  const session = (await response.json()) as SessionResponse;
  activeSessionId = session.sessionId;

  sessionStorage.setItem("printbit.mode", "print");
  sessionStorage.setItem("printbit.sessionId", session.sessionId);
  sessionStorage.removeItem("printbit.uploadedFile");
  sessionStorage.removeItem("printbit.uploadedFiles");

  setSessionText(session.sessionId);
  setSessionActive(true);
  updateUploadLink(session.token);

  attachSocket(session.sessionId);
  void checkUploadStatus();
  pollHandle = window.setInterval(() => void checkUploadStatus(), 2000);
}

async function checkUploadStatus(): Promise<void> {
  if (!activeSessionId) return;

  const response = await fetch(
    `/api/wireless/sessions/${encodeURIComponent(activeSessionId)}`,
  );
  if (!response.ok) return;

  const session = (await response.json()) as SessionResponse;

  // Never gate on status — session stays "uploaded" while accumulating
  // multiple files, so always read the full documents list.
  const rawFiles =
    session.documents && session.documents.length > 0
      ? session.documents
      : session.document
        ? [session.document]
        : [];

  const files: UploadedFile[] = rawFiles.map((file) => ({
    filename: file.filename,
    size: file.size ?? file.sizeBytes,
    sizeBytes: file.sizeBytes,
  }));

  files.forEach(addFileToList);

  if (files.length > 0) {
    sessionStorage.setItem(
      "printbit.uploadedFiles",
      JSON.stringify(files.map((f) => f.filename)),
    );
    sessionStorage.setItem("printbit.uploadedFile", files[0].filename);
  }
}

/** Socket: get instant notification when upload lands, no need to wait for poll. */
function attachSocket(sid: string): void {
  type SocketLike = {
    on: (e: string, cb: (...a: unknown[]) => void) => void;
    emit: (e: string, ...a: unknown[]) => void;
  };
  const ioFactory = (window as unknown as { io?: () => SocketLike }).io;
  if (typeof ioFactory !== "function") return;
  if (attachedSessionId === sid) return;

  const socket = ioFactory();
  attachedSessionId = sid;
  socket.emit("joinSession", sid);
  socket.on("UploadCompleted", () => void checkUploadStatus());
}

// ── Events ────────────────────────────────────────────────────────────────────

refreshSessionBtn?.addEventListener("click", () => void createSession());

continueBtn?.addEventListener("click", () => {
  if (!activeSessionId || !selectedFilename) return;
  window.location.href = `/config?mode=print&sessionId=${encodeURIComponent(activeSessionId)}&file=${encodeURIComponent(selectedFilename)}`;
});

// ── Boot ──────────────────────────────────────────────────────────────────────

void createSession();

export { navigateTo };
function navigateTo(path: string) {
  window.location.href = path;
}
