import fs from "node:fs";
import path from "node:path";
import { runPowerShell } from "@/utils";

export interface RemovableDrive {
  drive: string;
  label: string | null;
  freeBytes: number;
  totalBytes: number;
}

function parseDriveValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeDrives(raw: unknown): RemovableDrive[] {
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const drives: RemovableDrive[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const deviceId =
      typeof value.DeviceID === "string"
        ? value.DeviceID.toUpperCase().trim()
        : "";
    if (!/^[A-Z]:$/.test(deviceId)) continue;

    drives.push({
      drive: deviceId,
      label:
        typeof value.VolumeName === "string" && value.VolumeName.trim()
          ? value.VolumeName.trim()
          : null,
      freeBytes: parseDriveValue(value.FreeSpace),
      totalBytes: parseDriveValue(value.Size),
    });
  }

  return drives.sort((a, b) => a.drive.localeCompare(b.drive));
}

function ensureSafeDrive(drive: string): string {
  const normalized = drive.toUpperCase().trim();
  if (!/^[A-Z]:$/.test(normalized)) {
    throw new Error("Invalid USB drive identifier");
  }
  return normalized;
}

async function uniqueDestinationPath(directory: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(directory, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

class UsbDriveService {
  async listRemovable(): Promise<RemovableDrive[]> {
    const command =
      "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType = 2\" | Select-Object DeviceID, VolumeName, FreeSpace, Size | ConvertTo-Json -Compress";
    const raw = await runPowerShell(command);
    if (!raw) return [];
    return normalizeDrives(JSON.parse(raw) as unknown);
  }

  async exportScanTo(sourcePath: string, drive: string): Promise<{ exportPath: string; drive: string }> {
    const sourceAbsPath = path.resolve(sourcePath);
    if (!fs.existsSync(sourceAbsPath)) {
      throw new Error("Source scan file not found");
    }

    const safeDrive = ensureSafeDrive(drive);
    const drives = await this.listRemovable();
    const selected = drives.find((item) => item.drive === safeDrive);
    if (!selected) {
      throw new Error("USB drive not found. Please reinsert and refresh.");
    }

    const targetDir = path.join(`${safeDrive}\\`, "PrintBit", "Scans");
    await fs.promises.mkdir(targetDir, { recursive: true });

    const fileName = path.basename(sourceAbsPath);
    const targetPath = await uniqueDestinationPath(targetDir, fileName);
    await fs.promises.copyFile(sourceAbsPath, targetPath);

    return { exportPath: targetPath, drive: safeDrive };
  }
}

export const usbDriveService = new UsbDriveService();

export async function listRemovableDrives(): Promise<RemovableDrive[]> {
  return usbDriveService.listRemovable();
}

export async function exportScanToUsbDrive(sourcePath: string, drive: string): Promise<{ exportPath: string; drive: string }> {
  return usbDriveService.exportScanTo(sourcePath, drive);
}
