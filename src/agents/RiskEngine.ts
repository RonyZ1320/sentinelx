import { RiskLimits } from '../config/settings';
import { AdversaryReport, PortfolioState, RiskAssessment, ScoutReport, Thesis } from '../types';
import { assertFiniteNumber, clamp, newId, num, safeDivide, usd } from '../util';

export interface RiskEngineInput {
  thesis: Thesis;
  adversary: AdversaryReport;
  report: ScoutReport;
  portfolio: PortfolioState;
}

/**
 * Risk Engine — the veto. It sizes positions from a fixed-fractional risk
 * budget and refuses trades that break any limit. It can APPROVE, REDUCE
 * (smaller size, still tradable) or VETO (no trade).
 */
export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {}

  assess({ thesis, adversary, report, portfolio }: RiskEngineInput): RiskAssessment {
    const id = newId('rsk');
    const snapshot = report.snapshot;
    const limitsHit: string[] = [];
    const reasons: string[] = [];

    const rawStopDistancePct =
      safeDivide(thesis.entryPrice - thesis.stopPrice, thesis.entryPrice) * 100;
    const stopIsInvalid = !Number.isFinite(rawStopDistancePct) || rawStopDistancePct <= 0;
    const stopDistancePct = stopIsInvalid ? 0 : clamp(rawStopDistancePct, 0.01, 50);

    const veto = (reason: string, limit: string): RiskAssessment => {
      reasons.push(reason);
      limitsHit.push(limit);
      return {
        id,
        thesisId: thesis.id,
        action: 'VETO',
        approved: false,
        quantity: 0,
        notionalUsd: 0,
        riskUsd: 0,
        stopDistancePct,
        limitsHit,
        reasons,
      };
    };

    if (stopIsInvalid) {
      return veto(
        `Stop distance is zero, inverted or not finite (${rawStopDistancePct}).`,
        'INVALID_STOP',
      );
    }

    if (portfolio.halted) {
      return veto(
        `Trading halted: ${portfolio.haltedReason ?? 'circuit breaker active'}`,
        'DAILY_LOSS_CIRCUIT_BREAKER',
      );
    }

    const confidence = adversary.adjustedConfidence;
    if (adversary.verdict === 'REJECT') {
      return veto('Adversary rejected the thesis outright.', 'ADVERSARY_REJECT');
    }
    if (confidence < this.limits.minConfidence) {
      return veto(
        `Post-adversary confidence ${num(confidence * 100, 1)}% below the ${num(this.limits.minConfidence * 100, 1)}% minimum.`,
        'MIN_CONFIDENCE',
      );
    }

    const alreadyOpen = portfolio.openPositions.some((position) => position.symbol === thesis.symbol);
    if (alreadyOpen) {
      return veto(`Already holding ${thesis.symbol}; no pyramiding in v0.1.`, 'MAX_ONE_POSITION_PER_SYMBOL');
    }
    if (portfolio.openPositions.length >= this.limits.maxOpenPositions) {
      return veto(
        `Open positions (${portfolio.openPositions.length}) at the max of ${this.limits.maxOpenPositions}.`,
        'MAX_OPEN_POSITIONS',
      );
    }

    const lastCloseAt = portfolio.lastCloseAt[thesis.symbol];
    if (typeof lastCloseAt === 'number') {
      const minutesSinceClose = (report.generatedAt - lastCloseAt) / 60_000;
      if (minutesSinceClose < this.limits.reEntryCooldownMinutes) {
        return veto(
          `Closed ${thesis.symbol} ${num(Math.max(0, minutesSinceClose), 0)}m ago; re-entry cooldown is ${num(this.limits.reEntryCooldownMinutes, 0)}m.`,
          'RE_ENTRY_COOLDOWN',
        );
      }
    }

    if (snapshot.spreadPct > this.limits.maxSpreadPct) {
      return veto(
        `Spread ${num(snapshot.spreadPct, 3)}% exceeds the ${num(this.limits.maxSpreadPct, 3)}% limit.`,
        'MAX_SPREAD',
      );
    }

    if (Math.abs(snapshot.changePctBar) > this.limits.maxChaseMovePct) {
      return veto(
        `Last bar moved ${num(snapshot.changePctBar)}%, beyond the ${num(this.limits.maxChaseMovePct)}% chase limit.`,
        'MAX_CHASE_MOVE',
      );
    }

    // Fixed-fractional sizing: risk a fixed % of equity between entry and stop.
    const riskBudgetUsd = assertFiniteNumber(
      portfolio.equityUsd * (this.limits.maxRiskPerTradePct / 100),
      'risk budget',
    );
    let quantity = riskBudgetUsd / (thesis.entryPrice * (stopDistancePct / 100));
    assertFiniteNumber(quantity, 'position quantity');

    const maxNotionalByPolicy =
      portfolio.equityUsd * (this.limits.maxPositionPctOfEquity / 100) * this.limits.maxLeverage;
    let action: RiskAssessment['action'] = 'APPROVE';

    let notional = quantity * thesis.entryPrice;
    if (notional > maxNotionalByPolicy) {
      quantity = maxNotionalByPolicy / thesis.entryPrice;
      notional = quantity * thesis.entryPrice;
      action = 'REDUCE';
      limitsHit.push('MAX_POSITION_PCT');
      reasons.push(
        `Size cut to respect the ${num(this.limits.maxPositionPctOfEquity)}% of equity position cap (${usd(maxNotionalByPolicy)}).`,
      );
    }

    const cashCap = portfolio.cashUsd * 0.98;
    if (notional > cashCap) {
      quantity = cashCap / thesis.entryPrice;
      notional = quantity * thesis.entryPrice;
      action = 'REDUCE';
      limitsHit.push('AVAILABLE_CASH');
      reasons.push(`Size cut to fit available cash of ${usd(portfolio.cashUsd)}.`);
    }

    if (adversary.verdict === 'WEAKEN') {
      quantity *= 0.5;
      notional = quantity * thesis.entryPrice;
      action = 'REDUCE';
      limitsHit.push('ADVERSARY_WEAKEN');
      reasons.push('Size halved because the adversary materially weakened the thesis.');
    }

    const minNotionalUsd = 10;
    if (quantity <= 0 || notional < minNotionalUsd) {
      return veto(
        `Computed size ${usd(notional)} is below the ${usd(minNotionalUsd)} minimum — not worth the fees.`,
        'MIN_NOTIONAL',
      );
    }

    reasons.unshift(
      `Risking ${usd(quantity * thesis.entryPrice * (stopDistancePct / 100))} (${num(this.limits.maxRiskPerTradePct)}% of equity) with a ${num(stopDistancePct)}% stop.`,
    );

    return {
      id,
      thesisId: thesis.id,
      action,
      approved: true,
      quantity,
      notionalUsd: notional,
      riskUsd: quantity * thesis.entryPrice * (stopDistancePct / 100),
      stopDistancePct,
      limitsHit,
      reasons,
    };
  }
}
