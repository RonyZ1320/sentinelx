import { RiskLimits } from '../config/settings';
import { StrategyMemory } from '../memory/StrategyMemory';
import { MistakeTag, ScoutReport, Thesis } from '../types';
import { clamp, newId, num, pct } from '../util';

export interface ThesisEngineOptions {
  /** Reward:risk used to place the profit target. */
  rewardRiskRatio: number;
  minStopPct: number;
  maxStopPct: number;
  volatilityStopMultiplier: number;
}

const DEFAULT_OPTIONS: ThesisEngineOptions = {
  rewardRiskRatio: 2.2,
  minStopPct: 1.1,
  maxStopPct: 5,
  volatilityStopMultiplier: 1.6,
};

/**
 * Thesis Engine — turns a scout report into a falsifiable trade thesis with
 * entry, stop, target, confidence and an explicit invalidation condition.
 * Strategy Memory biases confidence using lessons from past autopsies.
 */
export class ThesisEngine {
  constructor(
    private readonly memory: StrategyMemory,
    private readonly limits: RiskLimits,
    private readonly options: ThesisEngineOptions = DEFAULT_OPTIONS,
  ) {}

  build(report: ScoutReport): Thesis | null {
    const { snapshot } = report;
    if (report.bias === 'NEUTRAL') return null;

    const volatilityStopPct = snapshot.volatilityPct * this.options.volatilityStopMultiplier;
    const stopDistancePct = clamp(
      volatilityStopPct,
      this.options.minStopPct,
      this.options.maxStopPct,
    );

    const direction = report.bias;
    const sign = direction === 'LONG' ? 1 : -1;
    const entryPrice = snapshot.price;
    const stopPrice = entryPrice * (1 - (sign * stopDistancePct) / 100);
    const targetPrice =
      entryPrice * (1 + (sign * stopDistancePct * this.options.rewardRiskRatio) / 100);

    const catalysts = report.events.slice(0, 3).map(
      (scored) => `${scored.event.headline} (sentiment ${num(scored.event.sentiment)}, score ${num(scored.score)})`,
    );

    const relevantTags: MistakeTag[] = [
      'CHASED_EXTENDED_MOVE',
      'LOW_CONVICTION_ENTRY',
      'EVENT_FADED',
      'POOR_LIQUIDITY',
    ];
    const memoryAdjustment = this.memory.adjustmentFor(snapshot.symbol, relevantTags);

    const topEventScore = report.events[0]?.score ?? 0;
    const anomalyScore = report.anomalies[0]?.severity ?? 0;
    const rawConfidence =
      0.34 +
      0.34 * report.opportunityScore +
      0.2 * clamp(topEventScore, 0, 1) +
      0.12 * clamp(anomalyScore, 0, 1) +
      memoryAdjustment;

    const spreadPenalty = clamp((snapshot.spreadPct - 0.08) / 2, 0, 0.12);
    const lowConvictionPenalty =
      report.opportunityScore < 0.40 ? 0.08 : 0;

    const confidence = clamp(
      rawConfidence - spreadPenalty - lowConvictionPenalty,
      0,
      0.95,
    );

    const rationale: string[] = [
      `Scout bias ${direction} with opportunity score ${num(report.opportunityScore * 100, 0)}%.`,
      catalysts.length > 0 ? `Catalyst(s): ${catalysts.join('; ')}` : 'No fresh catalyst — structure-driven only.',
      report.anomalies.length > 0
        ? `Abnormal conditions: ${report.anomalies.map((a) => `${a.type} (${a.detail})`).join('; ')}`
        : 'Market conditions look normal.',
      `Stop ${pct(stopDistancePct)} from entry, target ${pct(stopDistancePct * this.options.rewardRiskRatio)} (R:R ${this.options.rewardRiskRatio}).`,
      memoryAdjustment !== 0
        ? `Strategy memory applied ${pct(memoryAdjustment * 100, 1)} to confidence.`
        : 'Strategy memory had no stored lesson for this setup.',
    ];

    return {
      id: newId('ths'),
      scoutReportId: report.id,
      symbol: snapshot.symbol,
      direction,
      entryPrice,
      stopPrice,
      targetPrice,
      confidence,
      horizonMinutes: Math.max(30, this.limits.maxHoldingMinutes / 2),
      rationale,
      catalysts,
      invalidation:
        direction === 'LONG'
          ? `Price loses ${num(stopPrice)} or the catalyst is contradicted by a stronger bearish event.`
          : `Price reclaims ${num(stopPrice)} or the catalyst is contradicted by a stronger bullish event.`,
      createdFromLessons: this.memory.relevantLessons(snapshot.symbol).length,
    };
  }
}
