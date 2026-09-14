import { loadDotEnv, envBoolean, envNumber, envString } from './env';
import { SentinelXError } from '../util';

/** Hard-coded safety rails. These are intentionally NOT configurable upward. */
export const HARD_LIMITS = {
  maxLeverage: 1,
  maxPositionPctOfEquity: 25,
  maxRiskPerTradePct: 5,
  maxDailyLossPct: 20,
} as const;

export interface RiskLimits {
  /** Max notional of a single position as a percent of equity. */
  maxPositionPctOfEquity: number;
  /** Max equity risked (entry -> stop) per trade, in percent. */
  maxRiskPerTradePct: number;
  maxOpenPositions: number;
  /** Circuit breaker: halt the session after this daily drawdown, in percent. */
  maxDailyLossPct: number;
  maxLeverage: number;
  /** Below this post-adversary confidence the agent must HOLD. */
  minConfidence: number;
  /** Reject entries when the symbol already moved more than this, in percent. */
  maxChaseMovePct: number;
  /** Reject entries wider than this bid/ask spread, in percent. */
  maxSpreadPct: number;
  /** Close positions still open after this many minutes of sim time. */
  maxHoldingMinutes: number;
  /** Anti-churn: no re-entry into the same symbol for this long after a close. */
  reEntryCooldownMinutes: number;
}

export interface SentinelXSettings {
  mode: 'paper';
  symbols: string[];
  startingEquityUsd: number;
  cycles: number;
  seed: number;
  verbose: boolean;
  risk: RiskLimits;
  /** True when any exchange/news credential is present. v0.1 must stay false. */
  liveCredentialsConfigured: boolean;
  storageDir: string;
}

function clampLimit(value: number, hardMax: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, hardMax);
}

export function loadSettings(overrides: Partial<SentinelXSettings> = {}): SentinelXSettings {
  const fileEnv = loadDotEnv();

  const mode = envString('SENTINELX_MODE', 'paper', fileEnv).toLowerCase();
  if (mode !== 'paper') {
    throw new SentinelXError(
      `SENTINELX_MODE="${mode}" is not supported. SentinelX v0.1 is PAPER TRADING ONLY.`,
      'LIVE_TRADING_DISABLED',
    );
  }

  const symbols = envString('SENTINELX_SYMBOLS', 'AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,AMD', fileEnv)
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);

  const maxPositionPct = clampLimit(
    envNumber('SENTINELX_MAX_POSITION_PCT', 10, fileEnv),
    HARD_LIMITS.maxPositionPctOfEquity,
    10,
  );
  const maxRiskPerTradePct = clampLimit(
    envNumber('SENTINELX_MAX_RISK_PER_TRADE_PCT', 0.5, fileEnv),
    HARD_LIMITS.maxRiskPerTradePct,
    0.5,
  );
  const maxDailyLossPct = clampLimit(
    envNumber('SENTINELX_MAX_DAILY_LOSS_PCT', 3, fileEnv),
    HARD_LIMITS.maxDailyLossPct,
    3,
  );
  const maxLeverage = Math.min(
    Math.max(1, envNumber('SENTINELX_MAX_LEVERAGE', 1, fileEnv)),
    HARD_LIMITS.maxLeverage,
  );

  const settings: SentinelXSettings = {
    mode: 'paper',
    symbols: symbols.length > 0 ? symbols : ['AAPL'],
    startingEquityUsd: Math.max(100, envNumber('SENTINELX_STARTING_EQUITY', 10_000, fileEnv)),
    cycles: Math.max(1, Math.round(envNumber('SENTINELX_CYCLES', 48, fileEnv))),
    seed: Math.round(envNumber('SENTINELX_SEED', 1337, fileEnv)),
    verbose: envBoolean('SENTINELX_VERBOSE', false, fileEnv),
    risk: {
      maxPositionPctOfEquity: maxPositionPct,
      maxRiskPerTradePct,
      maxOpenPositions: Math.max(1, Math.round(envNumber('SENTINELX_MAX_OPEN_POSITIONS', 3, fileEnv))),
      maxDailyLossPct,
      maxLeverage,
      minConfidence: Math.min(
        0.95,
        Math.max(0.05, envNumber('SENTINELX_MIN_CONFIDENCE', 0.5, fileEnv)),
      ),
      maxChaseMovePct: 6,
      maxSpreadPct: 0.35,
      maxHoldingMinutes: 240,
      reEntryCooldownMinutes: Math.max(
        0,
        Math.round(envNumber('SENTINELX_REENTRY_COOLDOWN_MINUTES', 30, fileEnv)),
      ),
    },
    liveCredentialsConfigured:
      envString('BITGET_API_KEY', '', fileEnv).length > 0 ||
      envString('NEWS_API_KEY', '', fileEnv).length > 0,
    storageDir: envString('SENTINELX_STORAGE_DIR', '.sentinelx', fileEnv),
  };

  return { ...settings, ...overrides };
}
