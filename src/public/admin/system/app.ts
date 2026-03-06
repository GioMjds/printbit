import { SummaryResponse, apiFetch, setMessage, initAuth } from "../shared";

const serverStatus = document.getElementById("serverStatus") as HTMLElement;
const serverBadge = document.getElementById("serverBadge") as HTMLElement | null;
const hostStatus = document.getElementById("hostStatus") as HTMLElement;
const wifiStatus = document.getElementById("wifiStatus") as HTMLElement;
const wifiBadge = document.getElementById("wifiBadge") as HTMLElement | null;
const serialStatus = document.getElementById("serialStatus") as HTMLElement;
const serialBadge = document.getElementById("serialBadge") as HTMLElement | null;
const serialPortStatus = document.getElementById("serialPortStatus") as HTMLElement;

const printerStatus = document.getElementById("printerStatus") as HTMLElement;
const printerBadge = document.getElementById("printerBadge") as HTMLElement | null;
const printerNameEl = document.getElementById("printerName") as HTMLElement;
const inkGrid = document.getElementById("inkGrid") as HTMLElement;

const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
let refreshTimer: number | null = null;

function applySystem(summary: SummaryResponse): void {
  serverStatus.textContent = summary.status.serverRunning ? "Running" : "Down";
  serverBadge?.setAttribute("data-ok", String(summary.status.serverRunning));
  hostStatus.textContent = summary.status.host;
  wifiStatus.textContent = summary.status.wifiActive ? "Active" : "Inactive";
  wifiBadge?.setAttribute("data-ok", String(summary.status.wifiActive));
  serialStatus.textContent = summary.status.serial.connected ? "Connected" : "Disconnected";
  serialBadge?.setAttribute("data-ok", String(summary.status.serial.connected));
  serialPortStatus.textContent = summary.status.serial.portPath ?? "—";

  // Printer status
  const p = summary.status.printer;
  printerStatus.textContent = p.connected ? p.status : "Not Found";
  printerBadge?.setAttribute("data-ok", String(p.connected));
  printerNameEl.textContent = p.name ?? "—";

  // Ink / toner levels
  inkGrid.innerHTML = "";
  if (p.ink.length === 0) {
    inkGrid.innerHTML = `<div class="ink-empty">No supply data available</div>`;
    return;
  }

  for (const ink of p.ink) {
    const bar = document.createElement("div");
    bar.className = "ink-item";

    const pct = ink.level !== null ? ink.level : 0;
    const statusCls = `ink-bar--${ink.status}`;
    const label =
      ink.level !== null ? `${ink.level}%` : ink.status === "unknown" ? "N/A" : ink.status;

    bar.innerHTML =
      `<span class="ink-item__name">${ink.name}</span>` +
      `<div class="ink-bar"><div class="ink-bar__fill ${statusCls}" style="width:${pct}%"></div></div>` +
      `<span class="ink-item__label ink-item__label--${ink.status}">${label}</span>`;

    inkGrid.appendChild(bar);
  }
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/summary");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load system data.");
  }
  const summary = (await res.json()) as SummaryResponse;
  applySystem(summary);
}

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("System refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
