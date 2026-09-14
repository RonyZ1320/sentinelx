import {
  Anomaly,
  AnomalyType,
  Direction,
  MarketSnapshot,
  NewsEvent,
  ScoredEvent,
  ScoutReport,
} from '../types';
import { clamp, newId, safeDivide } from '../util';

export interface ScoutThresholds {
  volumeSpikeRatio: number;
  priceShockPct: number;
  volatilitySpikePct: number;
  spreadWideningPct: number;
  liquidationCascadePctOfOi: number;
  /** Events older than this are discounted to zero. */
  maxEventAgeMs: number;
}

export const DEFAULT_SCOUT_THRESHOLDS: ScoutThresholds = {
  volumeSpikeRatio: 1.8,
  priceShockPct: 0.8,
  volatilitySpikePct: 1.1,
  spreadWideningPct: 0.2,
  liquidationCascadePctOfOi: 0.03,
  maxEventAgeMs: 60 * 60 * 1000,
};

/**
 * Scout Agent — the senses. It looks for market-moving events and abnormal
 * market conditions, then scores how tradeable a symbol is right now.
 */
export class ScoutAgent {
  constructor(private readonly thresholds: ScoutThresholds = DEFAULT_SCOUT_THRESHOLDS) {}

  scan(snapshot: MarketSnapshot, events: NewsEvent[], now: number): ScoutReport {
    const relevant = events.filter(
      (event) => event.symbol === snapshot.symbol || event.symbol === 'MARKET',
    );
    const scoredEvents = relevant
      .map((event) => this.scoreEvent(event, now))
      .sort((a, b) => b.score - a.score);

    const anomalies = this.detectAnomalies(snapshot);
    const bias = this.biasFrom(scoredEvents, snapshot);
    const opportunityScore = this.opportunityScore(scoredEvents, anomalies, snapshot);

    return {
      id: newId('scout'),
      symbol: snapshot.symbol,
      generatedAt: now,
      snapshot,
      events: scoredEvents,
      anomalies,
      bias,
      opportunityScore,
      summary: this.summarize(snapshot, scoredEvents, anomalies, bias, opportunityScore),
    };
  }

  private scoreEvent(event: NewsEvent, now: number): ScoredEvent {
    const ageMs = Math.max(0, now - event.timestamp);
    const recency = clamp(1 - safeDivide(ageMs, this.thresholds.maxEventAgeMs), 0, 1);
    const score = clamp(Math.abs(event.sentiment) * event.credibility * (0.4 + 0.6 * recency), 0, 1);
    return { event, score, bias: event.sentiment >= 0 ? 'LONG' : 'SHORT' };
  }

  private detectAnomalies(snapshot: MarketSnapshot): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const { symbol } = snapshot;
    const volumeRatio = safeDivide(snapshot.volume24h, snapshot.avgVolume20d, 1);

    if (volumeRatio >= this.thresholds.volumeSpikeRatio) {
      anomalies.push({
        type: 'VOLUME_SPIKE',
        symbol,
        severity: clamp((volumeRatio - 1) / 2.5, 0.1, 1),
        detail: `Volume is ${volumeRatio.toFixed(2)}x its 20d baseline`,
      });
    }

    const barMove = Math.abs(snapshot.changePctBar);
    if (barMove >= this.thresholds.priceShockPct) {
      anomalies.push({
        type: 'PRICE_SHOCK',
        symbol,
        severity: clamp(barMove / 4, 0.1, 1),
        detail: `Last bar moved ${snapshot.changePctBar.toFixed(2)}%`,
      });
    }

    if (snapshot.volatilityPct >= this.thresholds.volatilitySpikePct) {
      anomalies.push({
        type: 'VOLATILITY_SPIKE',
        symbol,
        severity: clamp(snapshot.volatilityPct / 3, 0.1, 1),
        detail: `Realised volatility ${snapshot.volatilityPct.toFixed(2)}% per bar`,
      });
    }

    if (snapshot.spreadPct >= this.thresholds.spreadWideningPct) {
      anomalies.push({
        type: 'SPREAD_WIDENING',
        symbol,
        severity: clamp(snapshot.spreadPct / 1, 0.1, 1),
        detail: `Bid/ask spread widened to ${snapshot.spreadPct.toFixed(3)}%`,
      });
    }

    if (snapshot.price <= 0 || !Number.isFinite(snapshot.price)) {
      anomalies.push({
        type: 'STALE_DATA',
        symbol,
        severity: 1,
        detail: 'Non-finite price received from data provider',
      });
    }

    return anomalies.sort((a, b) => b.severity - a.severity);
  }

  private biasFrom(scoredEvents: ScoredEvent[], snapshot: MarketSnapshot): Direction | 'NEUTRAL' {
    let longWeight = 0;
    let shortWeight = 0;
    for (const scored of scoredEvents) {
      if (scored.bias === 'LONG') longWeight += scored.score;
      else shortWeight += scored.score;
    }
    longWeight += clamp(snapshot.changePctBar * 0.4, 0, 0.6);
    shortWeight += clamp(-snapshot.changePctBar * 0.4, 0, 0.6);

    const delta = longWeight - shortWeight;
    if (Math.abs(delta) < 0.12) return 'NEUTRAL';
    return delta > 0 ? 'LONG' : 'NEUTRAL';
  }

  private opportunityScore(
    scoredEvents: ScoredEvent[],
    anomalies: Anomaly[],
    snapshot: MarketSnapshot,
  ): number {
    const eventScore = scoredEvents.slice(0, 3).reduce((acc, item) => acc + item.score, 0) / 1.2;
    const anomalyScore = anomalies[0]?.severity ?? 0;
    const volumeRatio = clamp(safeDivide(snapshot.volume24h, snapshot.avgVolume20d, 1) / 3, 0, 1);
    return clamp(0.45 * clamp(eventScore, 0, 1) + 0.35 * anomalyScore + 0.2 * volumeRatio, 0, 1);
  }

  private summarize(
    snapshot: MarketSnapshot,
    scoredEvents: ScoredEvent[],
    anomalies: Anomaly[],
    bias: Direction | 'NEUTRAL',
    opportunityScore: number,
  ): string {
    const parts: string[] = [];
    parts.push(
      `${snapshot.symbol} @ ${snapshot.price.toFixed(2)} (${snapshot.changePctBar.toFixed(2)}% bar)`,
    );
    parts.push(scoredEvents.length > 0 ? `${scoredEvents.length} live catalyst(s)` : 'no catalysts');
    parts.push(anomalies.length > 0 ? `anomalies: ${anomalies.map((a) => a.type).join(', ')}` : 'no anomalies');
    parts.push(`bias ${bias}, opportunity ${(opportunityScore * 100).toFixed(0)}%`);
    return parts.join(' | ');
  }
}

export type { AnomalyType };
