import { RiskLimits } from '../config/settings';
import { StrategyMemory } from '../memory/StrategyMemory';
import {
  AdversaryReport,
  AutopsyReport,
  ClosedTrade,
  ExitReason,
  Lesson,
  MarketSnapshot,
  MistakeTag,
  RiskAssessment,
  Thesis,
  TradeDecision,
} from '../types';
import { clamp, newId, num, pct, usd } from '../util';

function humanExitReason(reason: ExitReason): string {
  return reason.toLowerCase().replace(/_/g, ' ');
}

function trimPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/** Everything captured at entry time, before the trade exists. */
export interface PendingDossier {
  thesis: Thesis;
  adversary: AdversaryReport | null;
  risk: RiskAssessment;
  decision: TradeDecision;
  entrySnapshot: MarketSnapshot;
}

export interface TradeDossier extends PendingDossier {
  trade: ClosedTrade;
}

interface Finding {
  tag: MistakeTag;
  detail: string;
  weight: number;
}

/**
 * Trade Autopsy — the honest post-mortem. For every closed trade it works out
 * what was actually wrong with the process (not just the P&L), grades it, and
 * hands a lesson to Strategy Memory.
 */
export class TradeAutopsy {
  constructor(
    private readonly memory: StrategyMemory,
    private readonly limits: RiskLimits,
  ) {}

  review(dossier: TradeDossier): AutopsyReport {
    const { trade, thesis, adversary, risk, decision, entrySnapshot } = dossier;
    const findings: Finding[] = [];
    const wentRight: string[] = [];

    const stopDistancePct = risk.stopDistancePct;
    const targetDistancePct = Math.abs(
      ((thesis.targetPrice - thesis.entryPrice) / thesis.entryPrice) * 100,
    );
    const peakGainPct = ((trade.peakPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const heldMinutes = (trade.closedAt - trade.openedAt) / 60_000;

    if (Math.abs(entrySnapshot.changePctBar) > 1.2) {
      findings.push({
        tag: 'CHASED_EXTENDED_MOVE',
        detail: `Entered on a ${pct(entrySnapshot.changePctBar)} bar — the easy part of the move was already gone.`,
        weight: 0.5,
      });
    } else {
      wentRight.push(`Entry was not extended (${pct(entrySnapshot.changePctBar)} bar move).`);
    }

    if (stopDistancePct < entrySnapshot.volatilityPct * 1.2) {
      findings.push({
        tag: 'STOP_TOO_TIGHT',
        detail: `Stop ${pct(stopDistancePct)} was inside normal noise (bar vol ${pct(entrySnapshot.volatilityPct)}).`,
        weight: 0.55,
      });
    } else if (stopDistancePct > this.limits.maxPositionPctOfEquity * 2) {
      findings.push({
        tag: 'STOP_TOO_WIDE',
        detail: `Stop ${pct(stopDistancePct)} gave the trade too much room relative to the ${pct(targetDistancePct)} target.`,
        weight: 0.35,
      });
    }

    if (entrySnapshot.spreadPct > this.limits.maxSpreadPct * 0.6) {
      findings.push({
        tag: 'POOR_LIQUIDITY',
        detail: `Traded into a ${num(entrySnapshot.spreadPct, 3)}% spread; fees+slippage were ${usd(trade.feesUsd)} on a ${usd(Math.abs(trade.pnlUsd))} result.`,
        weight: 0.3,
      });
    }

    if (decision.confidence < this.limits.minConfidence + 0.03) {
      findings.push({
        tag: 'LOW_CONVICTION_ENTRY',
        detail: `Entered at ${num(decision.confidence * 100, 1)}% confidence, barely above the ${num(this.limits.minConfidence * 100, 1)}% floor.`,
        weight: 0.25,
      });
    } else {
      wentRight.push(`Conviction was above the floor (${num(decision.confidence * 100, 1)}%).`);
    }

    if (adversary && adversary.verdict === 'WEAKEN' && risk.action === 'APPROVE') {
      findings.push({
        tag: 'IGNORED_ADVERSARY',
        detail: `Adversary weakened the thesis ("${adversary.killShot}") but the trade went on at full size.`,
        weight: 0.6,
      });
    } else if (adversary) {
      wentRight.push(`Adversary verdict ${adversary.verdict} was respected by the risk layer.`);
    }

    if (
      peakGainPct > stopDistancePct * 0.8 &&
      trade.exitReason === 'STOP_HIT' &&
      trade.pnlPct < 0
    ) {
      findings.push({
        tag: 'GAVE_BACK_PROFIT',
        detail: `Trade reached ${pct(peakGainPct)} before stopping out and still closed at ${pct(trade.pnlPct)}.`,
        weight: 0.5,
      });
    }

    if (trade.exitReason === 'SIGNAL_EXIT' && trade.pnlPct < 1) {
      findings.push({
        tag: 'PREMATURE_EXIT',
        detail: `Signal exit at ${pct(trade.pnlPct)} while the ${pct(targetDistancePct)} target was still live.`,
        weight: 0.3,
      });
    }

    if (trade.exitReason === 'STOP_HIT' && heldMinutes <= 15) {
      findings.push({
        tag: 'EVENT_FADED',
        detail: `Stopped out within ${num(heldMinutes, 0)} minutes — the catalyst did not follow through.`,
        weight: 0.45,
      });
    }

    if (trade.exitReason === 'TARGET_HIT' && trade.pnlPct > 1) {
      wentRight.push(`Plan executed end to end: entry ${usd(trade.entryPrice)} -> target ${usd(trade.exitPrice)}.`);
    }

    const mistakes: MistakeTag[] = findings.map((finding) => finding.tag);
    const wentWrong = findings.map((finding) => `[${finding.tag}] ${finding.detail}`);
    const processScore = clamp(1 - findings.reduce((acc, f) => acc + f.weight, 0) / 2, 0, 1);
    const grade = this.grade(processScore, trade.pnlPct);
    const lesson = this.buildLesson(trade, findings, wentRight);

    this.memory.remember(lesson);

    return {
      tradeId: trade.id,
      symbol: trade.symbol,
      pnlUsd: trade.pnlUsd,
      pnlPct: trade.pnlPct,
      exitReason: trade.exitReason,
      grade,
      mistakes,
      wentRight: wentRight.length > 0 ? wentRight : ['Nothing notable — the setup itself was marginal.'],
      wentWrong: wentWrong.length > 0 ? wentWrong : ['No process mistake found; result was mostly noise.'],
      lesson,
      reviewedAt: Date.now(),
    };
  }

  private grade(processScore: number, pnlPct: number): AutopsyReport['grade'] {
    const outcomeScore = clamp(0.5 + pnlPct / 8, 0, 1);
    const score = processScore * 0.7 + outcomeScore * 0.3;
    if (score >= 0.85) return 'A';
    if (score >= 0.7) return 'B';
    if (score >= 0.55) return 'C';
    if (score >= 0.4) return 'D';
    return 'F';
  }

  private buildLesson(trade: ClosedTrade, findings: Finding[], wentRight: string[]): Lesson {
    const now = Date.now();
    const worst = findings.sort((a, b) => b.weight - a.weight)[0];

    if (!worst) {
      return {
        id: newId('lsn'),
        tag: 'POSITIVE_PATTERN',
        symbol: trade.symbol,
        weight: trade.pnlUsd > 0 ? 0.35 : 0.1,
        statement:
          trade.pnlUsd > 0
            ? `Clean ${humanExitReason(trade.exitReason)} on ${trade.symbol} for ${usd(trade.pnlUsd)} — repeat this setup: ${trimPeriod(wentRight[0] ?? 'follow the plan')}.`
            : `${trade.symbol} followed the process but still lost ${usd(Math.abs(trade.pnlUsd))}; the setup is fine, size and stops are doing their job.`,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }

    return {
      id: newId('lsn'),
      tag: worst.tag,
      symbol: trade.symbol,
      weight: -clamp(worst.weight, 0.15, 0.6),
      statement: `${trade.symbol} ${trade.pnlUsd >= 0 ? 'made' : 'lost'} ${usd(Math.abs(trade.pnlUsd))} (${pct(trade.pnlPct)}): ${worst.detail}`,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }
}
