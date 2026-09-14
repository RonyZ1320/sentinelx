import { randomUUID } from 'node:crypto';

/** Deterministic PRNG (mulberry32) so demo runs are reproducible from a seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new SentinelXError('Rng.pick called with empty list');
    const index = Math.min(items.length - 1, Math.floor(this.next() * items.length));
    return items[index] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

export class SentinelXError extends Error {
  readonly code: string;

  constructor(message: string, code = 'SENTINELX_ERROR') {
    super(message);
    this.name = 'SentinelXError';
    this.code = code;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function pct(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function usd(value: number, decimals = 2): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}

export function num(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

export function timestampLabel(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

/** Never let a NaN/Infinity leak into a trade decision. */
export function assertFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new SentinelXError(`Invalid numeric value for ${label}: ${value}`, 'INVALID_NUMBER');
  }
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
