import { SummaryResponse, apiFetch, setMessage, initAuth } from "../shared";

const coins1 = document.getElementById("coins1") as HTMLElement;
const coins5 = document.getElementById("coins5") as HTMLElement;
const coins10 = document.getElementById("coins10") as HTMLElement;
const coins20 = document.getElementById("coins20") as HTMLElement;

const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
let refreshTimer: number | null = null;

function applyCoins(summary: SummaryResponse): void {
  coins1.textContent = String(summary.coinStats.one);
  coins5.textContent = String(summary.coinStats.five);
  coins10.textContent = String(summary.coinStats.ten);
  coins20.textContent = String(summary.coinStats.twenty);
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/summary");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load coin stats.");
  }
  const summary = (await res.json()) as SummaryResponse;
  applyCoins(summary);
}

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("Coin stats refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
