import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AutopsyReport,
  ClosedTrade,
  JournalEntry,
  PaperFill,
  PortfolioState,
  TradeDecision,
} from '../types';
import { SentinelXError } from '../util';

/**
 * Trade Journal — an append-only audit trail. Every cycle, decision, fill,
 * close and autopsy is written as one JSON line so the whole reasoning chain
 * of any trade can be replayed later.
 */
export interface JournalStats {
  decisions: number;
  buys: number;
  sells: number;
  holds: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossPnlUsd: number;
  feesUsd: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
}

export class TradeJournal {
  private readonly filePath: string;
  private readonly entries: JournalEntry[] = [];
  private readonly decisions: TradeDecision[] = [];
  private readonly trades: ClosedTrade[] = [];
  private readonly autopsies: AutopsyReport[] = [];

  constructor(storageDir: string, private readonly persist = true) {
    this.filePath = resolve(storageDir, 'journal.jsonl');
  }

  private write(entry: JournalEntry): void {
    this.entries.push(entry);
    if (!this.persist) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (cause) {
      throw new SentinelXError(
        `Unable to append to trade journal ${this.filePath}: ${(cause as Error).message}`,
        'JOURNAL_WRITE_FAILED',
      );
    }
  }

  recordCycle(cycle: number, timestamp: number, payload: unknown): void {
    this.write({ kind: 'CYCLE', cycle, timestamp, payload });
  }

  recordDecision(decision: TradeDecision, portfolio: PortfolioState): void {
    this.decisions.push(decision);
    this.write({
      kind: 'DECISION',
      cycle: decision.cycle,
      timestamp: decision.timestamp,
      payload: { decision, portfolio },
    });
  }

  recordFill(cycle: number, fill: PaperFill): void {
    this.write({ kind: 'FILL', cycle, timestamp: fill.timestamp, payload: fill });
  }

  recordTradeClosed(cycle: number, trade: ClosedTrade, autopsy: AutopsyReport | null): void {
    this.trades.push(trade);
    if (autopsy) this.autopsies.push(autopsy);
    this.write({ kind: 'TRADE_CLOSED', cycle, timestamp: trade.closedAt, payload: { trade, autopsy } });
  }

  recordRiskHalt(cycle: number, timestamp: number, reason: string): void {
    this.write({ kind: 'RISK_HALT', cycle, timestamp, payload: { reason } });
  }

  getDecisions(): TradeDecision[] {
    return [...this.decisions];
  }

  getClosedTrades(): ClosedTrade[] {
    return [...this.trades];
  }

  getAutopsies(): AutopsyReport[] {
    return [...this.autopsies];
  }

  stats(): JournalStats {
    const buys = this.decisions.filter((decision) => decision.action === 'BUY').length;
    const sells = this.decisions.filter((decision) => decision.action === 'SELL').length;
    const holds = this.decisions.filter((decision) => decision.action === 'HOLD').length;
    const wins = this.trades.filter((trade) => trade.pnlUsd > 0).length;
    return {
      decisions: this.decisions.length,
      buys,
      sells,
      holds,
      trades: this.trades.length,
      wins,
      losses: this.trades.length - wins,
      winRatePct: this.trades.length === 0 ? 0 : (wins / this.trades.length) * 100,
      grossPnlUsd: this.trades.reduce((acc, trade) => acc + trade.pnlUsd, 0),
      feesUsd: this.trades.reduce((acc, trade) => acc + trade.feesUsd, 0),
      bestTradeUsd: this.trades.reduce((acc, trade) => Math.max(acc, trade.pnlUsd), 0),
      worstTradeUsd: this.trades.reduce((acc, trade) => Math.min(acc, trade.pnlUsd), 0),
    };
  }

  /** Reads a previously written journal (used by `sentinelx review`). */
  static read(filePath: string): JournalEntry[] {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }
}
