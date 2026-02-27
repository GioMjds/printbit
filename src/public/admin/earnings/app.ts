import { SummaryResponse, apiFetch, setMessage, initAuth, peso } from "../shared";

const earningsToday = document.getElementById("earningsToday") as HTMLElement;
const earningsWeek = document.getElementById("earningsWeek") as HTMLElement;
const earningsAll = document.getElementById("earningsAll") as HTMLElement;
const eBarToday = document.getElementById("eBarToday") as HTMLElement | null;
const eBarWeek = document.getElementById("eBarWeek") as HTMLElement | null;

const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
let refreshTimer: number | null = null;

function applyEarnings(summary: SummaryResponse): void {
  earningsToday.textContent = peso(summary.earnings.today);
  earningsWeek.textContent = peso(summary.earnings.week);
  earningsAll.textContent = peso(summary.earnings.allTime);

  const maxE = summary.earnings.allTime || 1;
  if (eBarToday) eBarToday.style.width = `${Math.min(100, Math.round((summary.earnings.today / maxE) * 100))}%`;
  if (eBarWeek) eBarWeek.style.width = `${Math.min(100, Math.round((summary.earnings.week / maxE) * 100))}%`;
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/summary");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load earnings data.");
  }
  const summary = (await res.json()) as SummaryResponse;
  applyEarnings(summary);
}

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("Earnings refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
