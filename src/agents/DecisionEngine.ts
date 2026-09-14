import {
  AdversaryReport,
  DecisionAction,
  PortfolioState,
  RiskAssessment,
  ScoutReport,
  Thesis,
  TradeDecision,
} from '../types';
import { num } from '../util';
import { newId } from '../util';

export interface DecisionInput {
  cycle: number;
  timestamp: number;
  report: ScoutReport;
  thesis: Thesis | null;
  adversary: AdversaryReport | null;
  risk: RiskAssessment | null;
  portfolio: PortfolioState;
}

/**
 * Decision Engine — final arbiter. It never invents a view of its own: it
 * combines the scout report, thesis, adversary verdict and risk assessment
 * into exactly one BUY, SELL or HOLD, with the reasoning attached.
 */
export class DecisionEngine {
  decide(input: DecisionInput): TradeDecision {
    const { cycle, timestamp, report, thesis, adversary, risk, portfolio } = input;
    const id = newId('dec');
    const position = portfolio.openPositions.find((item) => item.symbol === report.symbol);

    const base = {
      id,
      cycle,
      timestamp,
      symbol: report.symbol,
      price: report.snapshot.price,
      scoutReportId: report.id,
      thesisId: thesis?.id ?? null,
      adversaryReportId: adversary?.id ?? null,
      riskAssessmentId: risk?.id ?? null,
    };

    const hold = (action: Extract<DecisionAction, 'HOLD'>, rationale: string[]): TradeDecision => ({
      ...base,
      action,
      direction: 'FLAT',
      quantity: 0,
      confidence: adversary?.adjustedConfidence ?? 0,
      rationale,
    });

    if (position) {
      const rationale: string[] = [
        `Holding ${num(position.quantity, 6)} ${report.symbol} from ${num(position.entryPrice)} (stop ${num(position.stopPrice)}, target ${num(position.targetPrice)}).`,
      ];

      const flippedAgainst = report.bias === 'SHORT' && report.opportunityScore >= 0.45;
      const thesisSaysExit = thesis?.direction === 'SHORT' && adversary?.verdict !== 'REJECT';

      if (flippedAgainst || thesisSaysExit) {
        rationale.push(
          flippedAgainst
            ? `Scout bias flipped against the long (opportunity ${num(report.opportunityScore * 100, 0)}%) — take the signal exit.`
            : 'Fresh thesis argues for exiting the current long.',
        );
        return {
          ...base,
          action: 'SELL',
          direction: 'SHORT',
          quantity: position.quantity,
          confidence: adversary?.adjustedConfidence ?? 0.5,
          rationale,
        };
      }

      rationale.push('No exit trigger: stop/target management stays with the risk layer.');
      return hold('HOLD', rationale);
    }

    if (!thesis) {
      return hold('HOLD', [
        report.summary,
        'No directional edge detected — Thesis Engine produced no falsifiable setup.',
      ]);
    }

    if (!risk || !risk.approved) {
      return hold('HOLD', [
        `Thesis ${thesis.direction} ${report.symbol} at confidence ${num(thesis.confidence * 100, 1)}%.`,
        `Risk Engine ${risk?.action ?? 'UNAVAILABLE'}: ${(risk?.reasons ?? ['no assessment']).join(' ')}`,
      ]);
    }

    if (thesis.direction === 'SHORT') {
      return hold('HOLD', [
        `Bearish thesis on ${report.symbol}, but v0.1 paper mode is long-only (no shorting, no leverage).`,
        ...(adversary ? [`Adversary kill shot: ${adversary.killShot}`] : []),
      ]);
    }

    return {
      ...base,
      action: 'BUY',
      direction: 'LONG',
      quantity: risk.quantity,
      confidence: adversary?.adjustedConfidence ?? thesis.confidence,
      rationale: [
        `BUY ${num(risk.quantity, 6)} ${report.symbol} @ ${num(thesis.entryPrice)} — confidence ${num((adversary?.adjustedConfidence ?? thesis.confidence) * 100, 1)}%.`,
        ...thesis.rationale.slice(0, 2),
        ...(adversary ? [`Adversary verdict ${adversary.verdict}: ${adversary.killShot}`] : []),
        `Risk Engine ${risk.action}: ${risk.reasons.join(' ')}`,
      ],
    };
  }
}
