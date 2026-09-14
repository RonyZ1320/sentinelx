/**
 * SentinelX domain types.
 *
 * Everything the agents exchange is described here so modules stay decoupled:
 * data providers produce `MarketSnapshot` / `NewsEvent`, agents produce reports,
 * the broker produces fills, and the journal persists plain JSON.
 */

export type Symbol_ = string;

export type Direction = 'LONG' | 'SHORT';

/** Final, human readable action emitted by the Decision Engine. */
export type DecisionAction = 'BUY' | 'SELL' | 'HOLD';

export type RiskAction = 'APPROVE' | 'REDUCE' | 'VETO';

export type AdversaryVerdict = 'SURVIVE' | 'WEAKEN' | 'REJECT';

export type EventCategory =
  | 'REGULATION'
  | 'MACRO'
  | 'EARNINGS'
  | 'PRODUCT'
  | 'ANALYST'
  | 'SOCIAL'
  | 'LIQUIDITY';

export type AnomalyType =
  | 'VOLUME_SPIKE'
  | 'PRICE_SHOCK'
  | 'VOLATILITY_SPIKE'
  | 'SPREAD_WIDENING'
  | 'LIQUIDATION_CASCADE'
  | 'STALE_DATA';

export interface MarketSnapshot {
  symbol: Symbol_;
  /** Last traded price in the instrument's quote currency. */
  price: number;
  /** Rolling 24h change in percent. */
  changePct24h: number;
  /** Absolute move over the last observed bar, in percent. */
  changePctBar: number;
  volume24h: number;
  /** Average 24h volume over the lookback window (baseline). */
  avgVolume20d: number;
  /** Realised volatility in percent. */
  volatilityPct: number;
  /** Bid/ask spread in percent of mid. */
  spreadPct: number;
  /** Open interest proxy, 0 when unknown. */
  openInterest: number;
  /** Liquidations over the lookback window in quote currency. */
  liquidations24h: number;
  /** Unix ms. */
  timestamp: number;
}

export interface NewsEvent {
  id: string;
  symbol: Symbol_ | 'MARKET';
  headline: string;
  category: EventCategory;
  /** -1 (very bearish) .. +1 (very bullish). */
  sentiment: number;
  /** 0 .. 1 credibility / source quality. */
  credibility: number;
  /** Unix ms. */
  timestamp: number;
  source: string;
}

export interface Anomaly {
  type: AnomalyType;
  symbol: Symbol_;
  /** 0 .. 1 severity. */
  severity: number;
  detail: string;
}

export interface ScoredEvent {
  event: NewsEvent;
  /** 0 .. 1 combined impact score. */
  score: number;
  bias: Direction;
}

export interface ScoutReport {
  id: string;
  symbol: Symbol_;
  generatedAt: number;
  snapshot: MarketSnapshot;
  events: ScoredEvent[];
  anomalies: Anomaly[];
  bias: Direction | 'NEUTRAL';
  /** 0 .. 1 — how tradeable this symbol looks right now. */
  opportunityScore: number;
  summary: string;
}

export interface Thesis {
  id: string;
  scoutReportId: string;
  symbol: Symbol_;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  /** 0 .. 1 */
  confidence: number;
  horizonMinutes: number;
  rationale: string[];
  catalysts: string[];
  /** Condition that falsifies the thesis. */
  invalidation: string;
  createdFromLessons: number;
}

export interface Objection {
  title: string;
  detail: string;
  /** 0 .. 1 damage to the thesis. */
  weight: number;
}

export interface AdversaryReport {
  id: string;
  thesisId: string;
  objections: Objection[];
  failureModes: string[];
  /** Single most likely reason this trade loses. */
  killShot: string;
  /** Confidence after red-teaming. */
  adjustedConfidence: number;
  verdict: AdversaryVerdict;
}

export interface RiskAssessment {
  id: string;
  thesisId: string;
  action: RiskAction;
  approved: boolean;
  /** Base currency quantity to trade. */
  quantity: number;
  notionalUsd: number;
  riskUsd: number;
  /** Percent of entry price. */
  stopDistancePct: number;
  limitsHit: string[];
  reasons: string[];
}

export interface TradeDecision {
  id: string;
  cycle: number;
  timestamp: number;
  action: DecisionAction;
  symbol: Symbol_;
  direction: Direction | 'FLAT';
  quantity: number;
  price: number;
  confidence: number;
  rationale: string[];
  scoutReportId: string;
  thesisId: string | null;
  adversaryReportId: string | null;
  riskAssessmentId: string | null;
}

export interface PaperFill {
  id: string;
  symbol: Symbol_;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  feeUsd: number;
  slippageUsd: number;
  timestamp: number;
}

export interface PaperPosition {
  symbol: Symbol_;
  side: 'LONG';
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  openedAt: number;
  thesisId: string;
  decisionId: string;
  peakPrice: number;
  feesPaidUsd: number;
}

export interface PortfolioState {
  cashUsd: number;
  equityUsd: number;
  openPositions: PaperPosition[];
  realizedPnlUsd: number;
  startingEquityUsd: number;
  dailyStartEquityUsd: number;
  halted: boolean;
  haltedReason: string | null;
  /** Unix ms of the most recent close per symbol (anti-churn cooldown). */
  lastCloseAt: Record<string, number>;
}

export interface ClosedTrade {
  id: string;
  symbol: Symbol_;
  side: 'LONG';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  pnlPct: number;
  feesUsd: number;
  openedAt: number;
  closedAt: number;
  exitReason: ExitReason;
  thesisId: string;
  decisionId: string;
  peakPrice: number;
}

export type ExitReason =
  | 'TARGET_HIT'
  | 'STOP_HIT'
  | 'SIGNAL_EXIT'
  | 'TIME_EXIT'
  | 'END_OF_SIMULATION';

export type MistakeTag =
  | 'CHASED_EXTENDED_MOVE'
  | 'STOP_TOO_TIGHT'
  | 'STOP_TOO_WIDE'
  | 'SIZE_TOO_LARGE'
  | 'IGNORED_ADVERSARY'
  | 'LOW_CONVICTION_ENTRY'
  | 'GAVE_BACK_PROFIT'
  | 'PREMATURE_EXIT'
  | 'EVENT_FADED'
  | 'POOR_LIQUIDITY'
  | 'REPEATED_PATTERN';

export interface AutopsyReport {
  tradeId: string;
  symbol: Symbol_;
  pnlUsd: number;
  pnlPct: number;
  exitReason: ExitReason;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  mistakes: MistakeTag[];
  wentRight: string[];
  wentWrong: string[];
  lesson: Lesson;
  reviewedAt: number;
}

export interface Lesson {
  id: string;
  tag: MistakeTag | 'POSITIVE_PATTERN';
  symbol: Symbol_ | 'ALL';
  /** -1 .. +1; negative lowers future confidence, positive raises it. */
  weight: number;
  statement: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface JournalEntry {
  kind: 'CYCLE' | 'DECISION' | 'FILL' | 'TRADE_CLOSED' | 'RISK_HALT';
  timestamp: number;
  cycle: number;
  payload: unknown;
}

export interface CycleContext {
  cycle: number;
  timestamp: number;
  symbol: Symbol_;
  snapshot: MarketSnapshot;
  events: NewsEvent[];
}
