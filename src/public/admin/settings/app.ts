import { SettingsResponse, apiFetch, setMessage, initAuth, setAdminPin } from "../shared";

const settingsForm = document.getElementById("settingsForm") as HTMLFormElement;
const settingPrintPerPage = document.getElementById("settingPrintPerPage") as HTMLInputElement;
const settingCopyPerPage = document.getElementById("settingCopyPerPage") as HTMLInputElement;
const settingColorSurcharge = document.getElementById("settingColorSurcharge") as HTMLInputElement;
const settingIdleTimeout = document.getElementById("settingIdleTimeout") as HTMLInputElement;
const settingAdminPin = document.getElementById("settingAdminPin") as HTMLInputElement;
const settingAdminLocalOnly = document.getElementById("settingAdminLocalOnly") as HTMLInputElement;

const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
let refreshTimer: number | null = null;

function applySettings(settings: SettingsResponse): void {
  settingPrintPerPage.value = settings.pricing.printPerPage.toFixed(2);
  settingCopyPerPage.value = settings.pricing.copyPerPage.toFixed(2);
  settingColorSurcharge.value = settings.pricing.colorSurcharge.toFixed(2);
  settingIdleTimeout.value = String(settings.idleTimeoutSeconds);
  settingAdminPin.value = settings.adminPin;
  settingAdminLocalOnly.checked = settings.adminLocalOnly;
}

async function loadData(): Promise<void> {
  const res = await apiFetch("/api/admin/settings");
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid admin PIN.");
    throw new Error("Failed to load settings.");
  }
  const settings = (await res.json()) as SettingsResponse;
  applySettings(settings);
}

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const payload = {
    pricing: {
      printPerPage: Number(settingPrintPerPage.value),
      copyPerPage: Number(settingCopyPerPage.value),
      colorSurcharge: Number(settingColorSurcharge.value),
    },
    idleTimeoutSeconds: Number(settingIdleTimeout.value),
    adminPin: settingAdminPin.value.trim(),
    adminLocalOnly: settingAdminLocalOnly.checked,
  };

  setMessage("Saving settings...");
  void apiFetch("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  })
    .then(async (response) => {
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to save settings.");
      }
      setAdminPin(payload.adminPin);
      await loadData();
      setMessage("Settings saved.");
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : "Failed to save settings.";
      setMessage(msg);
    });
});

refreshBtn.addEventListener("click", () => {
  setMessage("Refreshing...");
  void loadData()
    .then(() => setMessage("Settings refreshed."))
    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Refresh failed."));
});

initAuth(async () => {
  await loadData();
  if (refreshTimer !== null) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void loadData(), 10_000);
});
