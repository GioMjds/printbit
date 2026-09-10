export interface PlatformWorkerFlags {
  defender: boolean;
  usb: boolean;
  trustedTime: boolean;
  networking: boolean;
}

function parseBool(val: string | undefined): boolean {
  if (!val) return false;
  const trimmed = val.trim().toLowerCase();
  return trimmed === 'true' || trimmed === '1' || trimmed === 'yes';
}

export function getPlatformWorkerFlags(
  env: NodeJS.ProcessEnv = process.env,
): PlatformWorkerFlags {
  return {
    defender: parseBool(env.PRINTBIT_WORKER_DEFENDER_ENABLED),
    usb: parseBool(env.PRINTBIT_WORKER_USB_ENABLED),
    trustedTime: parseBool(env.PRINTBIT_WORKER_TRUSTED_TIME_ENABLED),
    networking: parseBool(env.PRINTBIT_WORKER_NETWORKING_ENABLED),
  };
}
