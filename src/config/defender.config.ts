export interface DefenderConfig {
  readonly maxSignatureAgeHours: number;
  readonly scanTimeoutMs: number;
}

function readBoundedPositiveInt(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  varName: string,
): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(
      `Invalid configuration for ${varName}: expected an integer between ${min} and ${max}, got ${raw}`,
    );
  }

  return parsed;
}

export function getDefenderConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DefenderConfig {
  return {
    maxSignatureAgeHours: readBoundedPositiveInt(
      env.PRINTBIT_DEFENDER_MAX_SIGNATURE_AGE_HOURS,
      720,
      1,
      24 * 60,
      'PRINTBIT_DEFENDER_MAX_SIGNATURE_AGE_HOURS',
    ),
    scanTimeoutMs: readBoundedPositiveInt(
      env.PRINTBIT_DEFENDER_SCAN_TIMEOUT_MS,
      60_000,
      1_000,
      5 * 60_000,
      'PRINTBIT_DEFENDER_SCAN_TIMEOUT_MS',
    ),
  };
}