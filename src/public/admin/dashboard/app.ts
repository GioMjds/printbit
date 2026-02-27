import { SummaryResponse, apiFetch, setMessage, initAuth, peso, formatBytes } from "../shared";

const metricBalance = document.getElementById("metricBalance") as HTMLElement;
const earningsToday = document.getElementById("earningsToday") as HTMLElement;
const jobsTotal = document.getElementById("jobsTotal") as HTMLElement;
const jobsPrint = document.getElementById("jobsPrint") as HTMLElement;
const jobsCopy = document.getElementById("jobsCopy") as HTMLElement;
const storageFiles = document.getElementById("storageFiles") as HTMLElement;
const storageBytes = document.getElementById("storageBytes") as HTMLElement;
const barPrint = document.getElementById("barPrint") as HTMLElement | null;
const barCopy = document.getElementById("barCopy") as HTMLElement | null;

const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
const resetBalanceBtn = document.getElementById("resetBalanceBtn") as HTMLButtonElement;
const clearStorageBtn = document.getElementById("clearStorageBtn") as HTMLButtonElement;

let refreshTimer: number | null = null;

function applySummary(summary: SummaryResponse): void {
  metricBalance.textContent = peso(summary.balance);
  earningsToday.textContent = peso(summary.earnings.today);
  jobsTotal.textContent = String(summary.jobStats.total);
  jobsPrint.textContent = String(summary.jobStats.print);
  jobsCopy.textContent = String(summary.jobStats.copy);
  storageFiles.textContent = String(summary.storage.fileCount);
  storageBytes.textContent = formatBytes(summary.storage.bytes);

  const total = summary.jobStats.total || 1;
  if (barPrint) barPrint.style.width = `${Math.round((summary.jobStats.print / total) * 100)}%`;
  if (barCopy) barCopy.style.width = `${Math.round((summary.jobStats.copy / total) * 100)}%`;
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/summary");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load dashboard data.");
  }
  const summary = (await res.json()) as SummaryResponse;
  applySummary(summary);
}

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("Dashboard refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

resetBalanceBtn.addEventListener("click", () => {
  if (!window.confirm("Reset machine balance to 0?")) return;
  setMessage("Resetting balance...");
  void apiFetch("/api/admin/balance/reset", { method: "POST" })
    .then(async (r) => {
      if (!r.ok) throw new Error("Failed to reset balance.");
      await loadData();
      setMessage("Balance reset.");
    })
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Failed to reset balance."));
});

clearStorageBtn.addEventListener("click", () => {
  if (!window.confirm("Clear uploaded files in storage?")) return;
  setMessage("Clearing storage...");
  void apiFetch("/api/admin/storage/clear", { method: "POST" })
    .then(async (r) => {
      if (!r.ok) throw new Error("Failed to clear storage.");
      await loadData();
      setMessage("Storage cleared.");
    })
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Failed to clear storage."));
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
