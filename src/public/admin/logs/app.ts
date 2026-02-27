import { LogsResponse, apiFetch, setMessage, initAuth } from "../shared";

const logsBody = document.getElementById("logsBody") as HTMLElement;
const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
const exportLogsBtn = document.getElementById("exportLogsBtn") as HTMLButtonElement;
let refreshTimer: number | null = null;

function applyLogs(logs: LogsResponse["logs"]): void {
  logsBody.innerHTML = "";
  for (const log of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(log.timestamp).toLocaleString()}</td>
      <td>${log.type}</td>
      <td>${log.message}</td>
    `;
    logsBody.appendChild(tr);
  }
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/logs?limit=120");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load logs.");
  }
  const data = (await res.json()) as LogsResponse;
  applyLogs(data.logs);
}

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("Logs refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

exportLogsBtn.addEventListener("click", () => {
  setMessage("Preparing logs export...");
  void apiFetch("/api/admin/logs/export.csv")
    .then(async (response) => {
      if (!response.ok) throw new Error("Failed to export logs.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `printbit-admin-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage("Logs exported.");
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : "Failed to export logs.";
      setMessage(msg);
    });
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
