import { StrategyMemory } from '../memory/StrategyMemory';
import { AdversaryReport, Objection, ScoutReport, Thesis } from '../types';
import { RiskLimits } from '../config/settings';
import { clamp, newId, num, pct } from '../util';

export interface AdversaryOptions {
  /** Total objection weight that flips the verdict to REJECT. */
  rejectDamage: number;
  /** Total objection weight that flips the verdict to WEAKEN. */
  weakenDamage: number;
  /** How much of the objection damage is applied to confidence (0..1). */
  damagePassThrough: number;
  extendedMovePct: number;
  highVolatilityPct: number;
}

const DEFAULT_OPTIONS: AdversaryOptions = {
  rejectDamage: 0.85,
  weakenDamage: 0.45,
  damagePassThrough: 0.45,
  extendedMovePct: 1.2,
  highVolatilityPct: 1.6,
};

/**
 * Adversary Agent — the self-critic. Its only job is to argue the trade
 * loses, then discount the thesis' confidence by the damage it inflicts.
 */
export class AdversaryAgent {
  constructor(
    private readonly memory: StrategyMemory,
    private readonly limits: RiskLimits,
    private readonly options: AdversaryOptions = DEFAULT_OPTIONS,
  ) {}

  challenge(thesis: Thesis, report: ScoutReport): AdversaryReport {
    const objections: Objection[] = [];
    const snapshot = report.snapshot;

    if (Math.abs(snapshot.changePctBar) >= this.options.extendedMovePct) {
      objections.push({
        title: 'You are chasing an extended bar',
        detail: `Entry is ${pct(snapshot.changePctBar)} into the move; adverse selection and mean reversion are likely.`,
        weight: 0.22,
      });
    }

    if (Math.abs(snapshot.changePct24h) >= this.limits.maxChaseMovePct) {
      objections.push({
        title: 'Move is already mature',
        detail: `24h change is ${pct(snapshot.changePct24h)} — most of the repricing may be done.`,
        weight: 0.16,
      });
    }

    if (report.events.length === 0) {
      objections.push({
        title: 'No catalyst',
        detail:
          report.anomalies.length === 0
            ? 'Nothing new is happening and the tape is quiet — this is a noise trade.'
            : 'Structure moved but there is no headline behind it; the cause is unknown.',
        weight: report.anomalies.length === 0 ? 0.2 : 0.12,
      });
    } else {
      const best = report.events[0];
      if (best && best.event.credibility < 0.6) {
        objections.push({
          title: 'Weak source',
          detail: `Best catalyst credibility is only ${num(best.event.credibility)} (${best.event.source}).`,
          weight: 0.14,
        });
      }
      if (best && Math.abs(best.event.sentiment) < 0.5) {
        objections.push({
          title: 'Ambiguous catalyst',
          detail: `Sentiment magnitude ${num(best.event.sentiment)} is too mild to move price reliably.`,
          weight: 0.1,
        });
      }
      const conflicting = report.events.filter(
        (scored) => scored.bias !== thesis.direction && scored.score > 0.25,
      );
      if (conflicting.length > 0) {
        objections.push({
          title: 'Conflicting narrative',
          detail: `${conflicting.length} catalyst(s) point the other way — the tape is not one-sided.`,
          weight: 0.20,
        });
      }
    }

    const spreadAnomaly = report.anomalies.find((a) => a.type === 'SPREAD_WIDENING');
    if (spreadAnomaly) {
      objections.push({
        title: 'Execution cost eats the edge',
        detail: `${spreadAnomaly.detail}; round-trip cost can exceed the expected edge on a ${pct(Math.abs((thesis.targetPrice - thesis.entryPrice) / thesis.entryPrice * 100))} target.`,
        weight: 0.14,
      });
    }

    const volumeRatio = snapshot.avgVolume20d > 0 ? snapshot.volume24h / snapshot.avgVolume20d : 1;
    if (volumeRatio < 0.75) {
      objections.push({
        title: 'Thin participation',
        detail: `Volume is ${num(volumeRatio)}x baseline; moves on thin books reverse fast.`,
        weight: 0.12,
      });
    }

    if (snapshot.volatilityPct >= this.options.highVolatilityPct) {
      objections.push({
        title: 'Noise can trigger the stop',
        detail: `Bar volatility ${pct(snapshot.volatilityPct)} is high relative to a ${pct(Math.abs((thesis.entryPrice - thesis.stopPrice) / thesis.entryPrice * 100))} stop.`,
        weight: 0.16,
      });
    }

    if (thesis.direction === 'SHORT') {
      objections.push({
        title: 'Shorts are not executable in this build',
        detail: 'Paper mode is spot-style long-only; a SHORT thesis can only close an existing position.',
        weight: 0.3,
      });
    }

    const lessons = this.memory.relevantLessons(thesis.symbol, 3);
    const negativeLessons = lessons.filter((lesson) => {
      if (lesson.weight >= 0) return false;

      // Only apply a historical lesson when the current setup
      // actually matches the mistake we learned from.
      if (lesson.tag === 'CHASED_EXTENDED_MOVE') {
        return Math.abs(snapshot.changePctBar) >= this.options.extendedMovePct;
      }

      return true;
    });

    if (negativeLessons.length > 0) {
      objections.push({
        title: 'We have lost on this pattern before',
        detail: negativeLessons
          .map((lesson) => `${lesson.tag} x${lesson.occurrences}: ${lesson.statement}`)
          .join(' | '),
        weight: clamp(0.1 * negativeLessons.length, 0.1, 0.2),
      });
    }

    const totalDamage = clamp(
      objections.reduce((acc, objection) => acc + objection.weight, 0),
      0,
      0.92,
    );
    const adjustedConfidence = clamp(
      thesis.confidence * (1 - totalDamage * this.options.damagePassThrough),
      0,
      0.95,
    );

    let verdict: AdversaryReport['verdict'] = 'SURVIVE';
    if (totalDamage >= this.options.rejectDamage || adjustedConfidence < this.limits.minConfidence * 0.75) {
      verdict = 'REJECT';
    } else if (totalDamage >= this.options.weakenDamage) {
      verdict = 'WEAKEN';
    }

    const failureModes = [
      'Catalyst fades within one or two bars and price round-trips to the pre-event level.',
      'A counter-headline (regulatory or exchange-side) inverts the narrative instantly.',
      `Stop at ${num(thesis.stopPrice)} is hit by ordinary noise before the target at ${num(thesis.targetPrice)}.`,
      'Liquidity withdrawal widens spread so the simulated fill is materially worse than mid.',
    ];

    const killShot =
      objections.sort((a, b) => b.weight - a.weight)[0]?.detail ??
      'Nothing concrete enough to block it — but this thesis has no buffer: one contradicting headline or a single bar of mean reversion invalidates the entry.';

    return {
      id: newId('adv'),
      thesisId: thesis.id,
      objections,
      failureModes,
      killShot,
      adjustedConfidence,
      verdict,
    };
  }
}
