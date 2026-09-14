import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SentinelXError } from '../util';

/**
 * Minimal dependency-free `.env` loader. Only reads the file when no real
 * environment variable of the same name exists, so shell/env vars always win.
 */
export function loadDotEnv(filePath = resolve(process.cwd(), '.env')): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!existsSync(filePath)) return parsed;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new SentinelXError(`Unable to read ${filePath}: ${(cause as Error).message}`, 'ENV_READ_FAILED');
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) parsed[key] = value;
  }
  return parsed;
}

export function envString(key: string, fallback: string, fileEnv: Record<string, string> = {}): string {
  const value = process.env[key] ?? fileEnv[key];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

export function envNumber(
  key: string,
  fallback: number,
  fileEnv: Record<string, string> = {},
): number {
  const raw = envString(key, '', fileEnv);
  if (raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    // Never crash the demo because of a typo'd env var — fall back safely.
    process.stderr.write(`[sentinelx] ignoring non-numeric ${key}="${raw}", using ${fallback}\n`);
    return fallback;
  }
  return parsed;
}

export function envBoolean(
  key: string,
  fallback: boolean,
  fileEnv: Record<string, string> = {},
): boolean {
  const raw = envString(key, '', fileEnv).toLowerCase();
  if (raw.length === 0) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
