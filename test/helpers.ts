import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSettings, SentinelXSettings } from '../src/config/settings';
import { DataLayer, SimClock } from '../src/data';
import { EventFeed } from '../src/data/EventFeed';
import { MarketDataProvider } from '../src/data/MarketDataProvider';
import { ScoutAgent } from '../src/agents/ScoutAgent';
import {
  AdversaryReport,
  ClosedTrade,
  ExitReason,
  MarketSnapshot,
  NewsEvent,
  PortfolioState,
  RiskAssessment,
  ScoutReport,
  Symbol_,
  Thesis,
  TradeDecision,
} from '../src/types';

export const MINUTE_MS = 60_000;
export const FAKE_BAR_MINUTES = 5;
export const FAKE_START = Date.UTC(2026, 0, 5, 12, 0, 0);

export interface TempStorage {
  dir: string;
  cleanup(): void;
}

/** Isolated storage dir so tests never touch the repo's `.sentinelx/`. */
export function tempStorage(label: string): TempStorage {
  const dir = mkdtempSync(join(tmpdir(), `sentinelx-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeSettings(overrides: Partial<SentinelXSettings> = {}): SentinelXSettings {
  const base = loadSettings({ symbols: ['FAKEUSDT'], cycles: 1, seed: 11 });
  return { ...base, ...overrides, risk: { ...base.risk, ...(overrides.risk ?? {}) } };
}

export function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'FAKEUSDT',
    price: 100,
    changePct24h: 1,
    changePctBar: 0.4,
    volume24h: 500_000_000,
    avgVolume20d: 200_000_000,
    volatilityPct: 0.35,
    spreadPct: 0.03,
    openInterest: 1_000_000_000,
    liquidations24h: 1_000_000,
    timestamp: FAKE_START,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<NewsEvent> = {}): NewsEvent {
  return {
    id: 'evt_test_1',
    symbol: 'FAKEUSDT',
    headline: 'FAKE: large institutional accumulation reported',
    category: 'EARNINGS',
    sentiment: 0.9,
    credibility: 0.95,
    timestamp: FAKE_START,
    source: 'test-wire',
    ...overrides,
  };
}

export function scan(snapshot: MarketSnapshot, events: NewsEvent[] = []): ScoutReport {
  return new ScoutAgent().scan(snapshot, events, snapshot.timestamp);
}

export function makeThesis(overrides: Partial<Thesis> = {}): Thesis {
  return {
    id: 'ths_test',
    scoutReportId: 'scout_test',
    symbol: 'FAKEUSDT',
    direction: 'LONG',
    entryPrice: 100,
    stopPrice: 98.9,
    targetPrice: 102.42,
    confidence: 0.8,
    horizonMinutes: 120,
    rationale: ['test rationale'],
    catalysts: ['test catalyst'],
    invalidation: 'price loses 98.9',
    createdFromLessons: 0,
    ...overrides,
  };
}

export function makeAdversary(overrides: Partial<AdversaryReport> = {}): AdversaryReport {
  return {
    id: 'adv_test',
    thesisId: 'ths_test',
    objections: [],
    failureModes: ['test failure mode'],
    killShot: 'test kill shot',
    adjustedConfidence: 0.8,
    verdict: 'SURVIVE',
    ...overrides,
  };
}

export function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    cashUsd: 10_000,
    equityUsd: 10_000,
    openPositions: [],
    realizedPnlUsd: 0,
    startingEquityUsd: 10_000,
    dailyStartEquityUsd: 10_000,
    halted: false,
    haltedReason: null,
    lastCloseAt: {},
    ...overrides,
  };
}

export function makeRisk(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    id: 'rsk_test',
    thesisId: 'ths_test',
    action: 'APPROVE',
    approved: true,
    quantity: 2,
    notionalUsd: 200,
    riskUsd: 2.2,
    stopDistancePct: 1.1,
    limitsHit: [],
    reasons: ['test sizing'],
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<TradeDecision> = {}): TradeDecision {
  return {
    id: 'dec_test',
    cycle: 1,
    timestamp: FAKE_START,
    action: 'BUY',
    symbol: 'FAKEUSDT',
    direction: 'LONG',
    quantity: 2,
    price: 100,
    confidence: 0.8,
    rationale: ['test decision'],
    scoutReportId: 'scout_test',
    thesisId: 'ths_test',
    adversaryReportId: 'adv_test',
    riskAssessmentId: 'rsk_test',
    ...overrides,
  };
}

export function makeClosedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: 'trd_test',
    symbol: 'FAKEUSDT',
    side: 'LONG',
    quantity: 2,
    entryPrice: 100,
    exitPrice: 102.5,
    pnlUsd: 4.9,
    pnlPct: 2.45,
    feesUsd: 0.24,
    openedAt: FAKE_START,
    closedAt: FAKE_START + 10 * MINUTE_MS,
    exitReason: 'TARGET_HIT' as ExitReason,
    thesisId: 'ths_test',
    decisionId: 'dec_test',
    peakPrice: 102.5,
    ...overrides,
  };
}

export interface FakeTick {
  snapshots: MarketSnapshot[];
  events?: NewsEvent[];
}

/** Ordered script of bars handed to `FakeDataLayer`. */
export type FakeScript = FakeTick[];

/**
 * Scripted, fully deterministic stand-in for the Bitget data layer. Tests push
 * a list of bars; each `tick()` advances one bar and releases that bar's events.
 */
export class FakeDataLayer implements DataLayer, MarketDataProvider, EventFeed, SimClock {
  readonly name = 'fake-data';
  readonly isSimulated = true;
  readonly market: MarketDataProvider = this;
  readonly events: EventFeed = this;
  readonly world: SimClock = this;

  private index = -1;
  private current: FakeTick;

  constructor(
    private readonly ticks: FakeTick[],
    private readonly universe: Symbol_[] = ['FAKEUSDT'],
  ) {
    if (ticks.length === 0) throw new Error('FakeDataLayer needs at least one scripted tick');
    this.current = ticks[0] as FakeTick;
  }

  barMinutes(): number {
    return FAKE_BAR_MINUTES;
  }

  now(): number {
    return FAKE_START + Math.max(0, this.index + 1) * FAKE_BAR_MINUTES * MINUTE_MS;
  }

  symbols(): Symbol_[] {
    return [...this.universe];
  }

  async tick(): Promise<void> {
    if (this.index < this.ticks.length - 1) this.index += 1;
    this.current = this.ticks[Math.max(0, this.index)] as FakeTick;
  }

  async getSnapshot(symbol: Symbol_): Promise<MarketSnapshot> {
    const found = this.current.snapshots.find((snapshot) => snapshot.symbol === symbol);
    if (!found) throw new Error(`FakeDataLayer has no snapshot for ${symbol}`);
    return { ...found, timestamp: this.now() };
  }

  async getSnapshots(symbols: Symbol_[]): Promise<MarketSnapshot[]> {
    return Promise.all(symbols.map((symbol) => this.getSnapshot(symbol)));
  }

  async poll(): Promise<NewsEvent[]> {
    const events = this.current.events ?? [];
    // Release each scripted event once, at the bar it belongs to.
    this.current = { ...this.current, events: [] };
    return events.map((event) => ({ ...event, timestamp: this.now() }));
  }
}
