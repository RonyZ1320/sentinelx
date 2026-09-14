import { JournalStats } from '../journal/TradeJournal';
import {
  AdversaryReport,
  AutopsyReport,
  ClosedTrade,
  Lesson,
  PortfolioState,
  RiskAssessment,
  ScoutReport,
  Thesis,
  TradeDecision,
} from '../types';
import { num, pct, timestampLabel, usd } from '../util';

const WIDTH = 96;

export function rule(char = '-'): string {
  return char.repeat(WIDTH);
}

export function banner(lines: string[]): string {
  const inner = lines.map((line) => `  ${line}`);
  const width = Math.max(WIDTH, ...inner.map((line) => line.length + 2));
  const border = `+${'-'.repeat(width - 2)}+`;
  return [border, ...inner.map((line) => `|${line.padEnd(width - 2, ' ')}|`), border].join('\n');
}

export function cycleHeader(cycle: number, timestamp: number, portfolio: PortfolioState): string {
  return [
    rule('='),
    `CYCLE ${String(cycle).padStart(3, '0')}  |  ${timestampLabel(timestamp)}  |  equity ${usd(portfolio.equityUsd)}  |  cash ${usd(portfolio.cashUsd)}  |  open ${portfolio.openPositions.length}${portfolio.halted ? '  |  HALTED' : ''}`,
    rule('='),
  ].join('\n');
}

export function formatScout(report: ScoutReport): string {
  const events = report.events
    .slice(0, 2)
    .map((scored) => `${scored.event.headline} [${scored.event.category} ${num(scored.event.sentiment)}]`)
    .join(' ; ') || 'no catalysts';
  const anomalies = report.anomalies.map((anomaly) => anomaly.type).join(',') || 'none';
  return [
    `  SCOUT   ${report.symbol.padEnd(9)} ${num(report.snapshot.price).padStart(12)}  bar ${pct(report.snapshot.changePctBar).padStart(8)}  opp ${num(report.opportunityScore * 100, 0).padStart(3)}%  bias ${report.bias}`,
    `          anomalies: ${anomalies}`,
    `          events: ${events}`,
  ].join('\n');
}

export function formatThesis(thesis: Thesis | null, adversary: AdversaryReport | null): string {
  if (!thesis) return '  THESIS  none — no falsifiable setup';
  const lines = [
    `  THESIS  ${thesis.direction} ${thesis.symbol} @ ${num(thesis.entryPrice)}  stop ${num(thesis.stopPrice)}  target ${num(thesis.targetPrice)}  conf ${num(thesis.confidence * 100, 1)}%`,
    `          why: ${thesis.rationale[0] ?? 'n/a'}`,
    `          invalidated by: ${thesis.invalidation}`,
  ];
  if (adversary) {
    lines.push(
      `  ADVERSARY verdict ${adversary.verdict}  conf ${num(thesis.confidence * 100, 1)}% -> ${num(adversary.adjustedConfidence * 100, 1)}%  objections ${adversary.objections.length}`,
      `          kill shot: ${adversary.killShot}`,
    );
  }
  return lines.join('\n');
}

export function formatRisk(risk: RiskAssessment | null): string {
  if (!risk) return '  RISK    not evaluated';
  const limits = risk.limitsHit.length > 0 ? ` limits: ${risk.limitsHit.join(',')}` : '';
  return [
    `  RISK    ${risk.action}${risk.approved ? ` qty ${num(risk.quantity, 6)} notional ${usd(risk.notionalUsd)} risk ${usd(risk.riskUsd)} stop ${pct(risk.stopDistancePct)}` : ''}${limits}`,
    `          ${risk.reasons[0] ?? ''}`,
  ].join('\n');
}

export function formatDecision(decision: TradeDecision): string {
  const detail =
    decision.action === 'HOLD'
      ? decision.rationale.at(-1) ?? ''
      : `qty ${num(decision.quantity, 6)} @ ${num(decision.price)}`;
  return `  DECISION ${decision.action.padEnd(4)} ${decision.symbol.padEnd(9)} ${detail}`;
}

export function formatFillLine(symbol: string, side: string, quantity: number, price: number, fee: number): string {
  return `  FILL    ${side.padEnd(4)} ${num(quantity, 6)} ${symbol} @ ${num(price)} (fee ${usd(fee)}) [PAPER]`;
}

export function formatClosedTrade(trade: ClosedTrade): string {
  return `  CLOSED  ${trade.symbol.padEnd(9)} ${trade.exitReason.padEnd(18)} entry ${num(trade.entryPrice).padStart(11)} exit ${num(trade.exitPrice).padStart(11)} pnl ${usd(trade.pnlUsd).padStart(10)} (${pct(trade.pnlPct)})`;
}

export function formatAutopsy(autopsy: AutopsyReport): string {
  return [
    `  AUTOPSY ${autopsy.symbol} grade ${autopsy.grade}  ${usd(autopsy.pnlUsd)} (${pct(autopsy.pnlPct)})  exit ${autopsy.exitReason}`,
    ...autopsy.wentWrong.slice(0, 2).map((line) => `          wrong: ${line}`),
    `          lesson: ${autopsy.lesson.statement}`,
  ].join('\n');
}

export function formatLessons(lessons: Lesson[]): string {
  if (lessons.length === 0) return '  (strategy memory is empty)';
  return lessons
    .map(
      (lesson) =>
        `  ${lesson.tag.padEnd(22)} ${lesson.symbol.padEnd(9)} x${String(lesson.occurrences).padStart(2)}  weight ${num(lesson.weight, 2).padStart(6)}  ${lesson.statement}`,
    )
    .join('\n');
}

export function formatSummary(
  portfolio: PortfolioState,
  stats: JournalStats,
  trades: ClosedTrade[],
  lessons: Lesson[],
  elapsedBars: number,
  barMinutes: number,
): string {
  const returnPct = ((portfolio.equityUsd - portfolio.startingEquityUsd) / portfolio.startingEquityUsd) * 100;
  const lines = [
    rule('='),
    'SENTINELX PAPER SESSION SUMMARY',
    rule('='),
    `  mode              paper trading only (no real orders were placed)`,
    `  simulated span    ${num(elapsedBars * barMinutes, 0)} minutes (${elapsedBars} bars of ${barMinutes}m)`,
    `  starting equity   ${usd(portfolio.startingEquityUsd)}`,
    `  ending equity     ${usd(portfolio.equityUsd)}  (${pct(returnPct)})`,
    `  realized P&L      ${usd(portfolio.realizedPnlUsd)}`,
    `  cash              ${usd(portfolio.cashUsd)}`,
    `  decisions         ${stats.decisions} (BUY ${stats.buys} / SELL ${stats.sells} / HOLD ${stats.holds})`,
    `  closed trades     ${stats.trades}  win rate ${num(stats.winRatePct, 1)}%  (${stats.wins}W / ${stats.losses}L)`,
    `  best / worst      ${usd(stats.bestTradeUsd)} / ${usd(stats.worstTradeUsd)}`,
    `  fees paid         ${usd(stats.feesUsd)}`,
    `  circuit breaker   ${portfolio.halted ? `TRIPPED — ${portfolio.haltedReason}` : 'not tripped'}`,
    '',
    '  TRADES',
    trades.length === 0
      ? '  (no trades closed)'
      : trades
          .map(
            (trade) =>
              `    ${trade.symbol.padEnd(9)} ${trade.exitReason.padEnd(18)} ${usd(trade.pnlUsd).padStart(10)}  ${pct(trade.pnlPct).padStart(8)}`,
          )
          .join('\n'),
    '',
    '  STRATEGY MEMORY (lessons carried into future decisions)',
    formatLessons(lessons),
    rule('='),
  ];
  return lines.join('\n');
}
