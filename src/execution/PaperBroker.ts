import { RiskLimits } from '../config/settings';
import {
  ClosedTrade,
  ExitReason,
  MarketSnapshot,
  PaperFill,
  PaperPosition,
  PortfolioState,
  Thesis,
  TradeDecision,
} from '../types';
import { Rng, SentinelXError, assertFiniteNumber, clamp, newId, num, usd } from '../util';

export interface PaperBrokerOptions {
  startingEquityUsd: number;
  /** Taker fee in percent, Bitget spot-like default. */
  feePct: number;
  /** Extra slippage in percent on top of half the spread. */
  slippageBps: number;
  barMinutes: number;
}

const DEFAULT_OPTIONS: Omit<PaperBrokerOptions, 'startingEquityUsd'> = {
  feePct: 0.06,
  slippageBps: 2,
  barMinutes: 5,
};

/**
 * Paper Execution — simulated fills only.
 *
 * SAFETY: this class has no network client, no API credentials and no code
 * path that can reach an exchange. `assertPaperOnly()` is called on every
 * mutating operation so an accidental live wiring fails loudly instead of
 * silently placing an order.
 */
export class PaperBroker {
  private readonly options: PaperBrokerOptions;
  private readonly rng: Rng;
  private readonly positions = new Map<string, PaperPosition>();
  private readonly closedTrades: ClosedTrade[] = [];
  private readonly fills: PaperFill[] = [];
  private cashUsd: number;
  private realizedPnlUsd = 0;
  private dailyStartEquityUsd: number;
  private halted = false;
  private haltedReason: string | null = null;
  private lastPrices = new Map<string, number>();
  private readonly lastCloseAt = new Map<string, number>();

  constructor(
    private readonly limits: RiskLimits,
    options: Partial<PaperBrokerOptions> & { startingEquityUsd: number },
    seed: number,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.rng = new Rng(seed ^ 0x9e3779b9);
    this.cashUsd = assertFiniteNumber(this.options.startingEquityUsd, 'starting equity');
    this.dailyStartEquityUsd = this.cashUsd;
  }

  /** Guardrail: v0.1 must never talk to a real venue. */
  private assertPaperOnly(): void {
    if (process.env.SENTINELX_ALLOW_LIVE === 'true') {
      throw new SentinelXError(
        'Live trading is permanently disabled in SentinelX v0.1. Paper trading only.',
        'LIVE_TRADING_DISABLED',
      );
    }
  }

  portfolio(): PortfolioState {
    const equityUsd = this.equityUsd();
    return {
      cashUsd: this.cashUsd,
      equityUsd,
      openPositions: [...this.positions.values()],
      realizedPnlUsd: this.realizedPnlUsd,
      startingEquityUsd: this.options.startingEquityUsd,
      dailyStartEquityUsd: this.dailyStartEquityUsd,
      halted: this.halted,
      haltedReason: this.haltedReason,
      lastCloseAt: Object.fromEntries(this.lastCloseAt),
    };
  }

  equityUsd(): number {
    let equity = this.cashUsd;
    for (const position of this.positions.values()) {
      const mark = this.lastPrices.get(position.symbol) ?? position.entryPrice;
      equity += position.quantity * mark;
    }
    return equity;
  }

  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  history(): { fills: PaperFill[]; closedTrades: ClosedTrade[] } {
    return { fills: [...this.fills], closedTrades: [...this.closedTrades] };
  }

  /** Simulated market buy. Returns the fill plus the opened position. */
  openLong(
    decision: TradeDecision,
    thesis: Thesis,
    snapshot: MarketSnapshot,
  ): { fill: PaperFill; position: PaperPosition } | null {
    this.assertPaperOnly();
    if (this.halted) {
      throw new SentinelXError(`Cannot open ${thesis.symbol}: ${this.haltedReason}`, 'TRADING_HALTED');
    }
    if (this.positions.has(thesis.symbol)) return null;
    if (decision.quantity <= 0) return null;

    const fillPrice = this.fillPrice(snapshot, 'BUY');
    const notional = assertFiniteNumber(fillPrice * decision.quantity, 'notional');
    const feeUsd = notional * (this.options.feePct / 100);
    const totalCost = notional + feeUsd;

    if (totalCost > this.cashUsd) {
      // Re-size down rather than reject: keeps the demo moving without leverage.
      const affordableQty = (this.cashUsd * 0.99) / (fillPrice * (1 + this.options.feePct / 100));
      if (affordableQty * fillPrice < 10) return null;
      decision = { ...decision, quantity: affordableQty };
    }

    const quantity = decision.quantity;
    const executedNotional = fillPrice * quantity;
    const executedFee = executedNotional * (this.options.feePct / 100);
    const slippageUsd = Math.abs(fillPrice - snapshot.price) * quantity;

    this.cashUsd -= executedNotional + executedFee;

    const fill: PaperFill = {
      id: newId('fil'),
      symbol: thesis.symbol,
      side: 'BUY',
      quantity,
      price: fillPrice,
      feeUsd: executedFee,
      slippageUsd,
      timestamp: snapshot.timestamp,
    };
    const position: PaperPosition = {
      symbol: thesis.symbol,
      side: 'LONG',
      quantity,
      entryPrice: fillPrice,
      stopPrice: thesis.stopPrice,
      targetPrice: thesis.targetPrice,
      openedAt: snapshot.timestamp,
      thesisId: thesis.id,
      decisionId: decision.id,
      peakPrice: fillPrice,
      feesPaidUsd: executedFee,
    };

    this.fills.push(fill);
    this.positions.set(thesis.symbol, position);
    this.lastPrices.set(thesis.symbol, snapshot.price);
    return { fill, position };
  }

  /** Simulated market sell of the whole position. */
  closePosition(
    symbol: string,
    reason: ExitReason,
    snapshot: MarketSnapshot,
  ): ClosedTrade | null {
    this.assertPaperOnly();
    const position = this.positions.get(symbol);
    if (!position) return null;

    const exitPrice = this.fillPrice(snapshot, 'SELL');
    const gross = exitPrice * position.quantity;
    const feeUsd = gross * (this.options.feePct / 100);
    const entryCost = position.entryPrice * position.quantity;
    const totalFees = position.feesPaidUsd + feeUsd;
    const pnlUsd = gross - entryCost - totalFees;
    const pnlPct = clamp((pnlUsd / Math.max(entryCost, 1e-9)) * 100, -100, 1000);

    this.cashUsd += gross - feeUsd;
    this.realizedPnlUsd += pnlUsd;
    this.positions.delete(symbol);
    this.lastPrices.set(symbol, snapshot.price);
    this.lastCloseAt.set(symbol, snapshot.timestamp);

    this.fills.push({
      id: newId('fil'),
      symbol,
      side: 'SELL',
      quantity: position.quantity,
      price: exitPrice,
      feeUsd,
      slippageUsd: Math.abs(exitPrice - snapshot.price) * position.quantity,
      timestamp: snapshot.timestamp,
    });

    const trade: ClosedTrade = {
      id: newId('trd'),
      symbol,
      side: 'LONG',
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      exitPrice,
      pnlUsd,
      pnlPct,
      feesUsd: totalFees,
      openedAt: position.openedAt,
      closedAt: snapshot.timestamp,
      exitReason: reason,
      thesisId: position.thesisId,
      decisionId: position.decisionId,
      peakPrice: Math.max(position.peakPrice, exitPrice),
    };
    this.closedTrades.push(trade);
    this.checkCircuitBreaker();
    return trade;
  }

  /**
   * Per-bar risk management: mark to market, update the peak price, enforce
   * stop-loss, take-profit and max holding time. Returns trades closed now.
   */
  manage(snapshot: MarketSnapshot): ClosedTrade[] {
    this.lastPrices.set(snapshot.symbol, snapshot.price);
    const position = this.positions.get(snapshot.symbol);
    if (!position) return [];

    position.peakPrice = Math.max(position.peakPrice, snapshot.price);

    // Protect a meaningful open profit after the trade reaches +1.5%.
    // The stop only ratchets upward and never loosens.
    const profitPct = ((position.peakPrice - position.entryPrice) / position.entryPrice) * 100;
    if (profitPct >= 0.8) {
      const protectedStop = position.entryPrice * 1.005;
      position.stopPrice = Math.max(position.stopPrice, protectedStop);
    }

    const heldMinutes = (snapshot.timestamp - position.openedAt) / 60_000;
    if (snapshot.price <= position.stopPrice) {
      return this.close(snapshot.symbol, 'STOP_HIT', snapshot) ?? [];
    }
    if (snapshot.price >= position.targetPrice) {
      return this.close(snapshot.symbol, 'TARGET_HIT', snapshot) ?? [];
    }
    if (heldMinutes >= this.limits.maxHoldingMinutes) {
      return this.close(snapshot.symbol, 'TIME_EXIT', snapshot) ?? [];
    }
    return [];
  }

  /** Flatten everything (end of demo). */
  closeAll(snapshots: MarketSnapshot[], reason: ExitReason): ClosedTrade[] {
    const closed: ClosedTrade[] = [];
    for (const snapshot of snapshots) {
      if (!this.positions.has(snapshot.symbol)) continue;
      const trade = this.closePosition(snapshot.symbol, reason, snapshot);
      if (trade) closed.push(trade);
    }
    return closed;
  }

  private close(symbol: string, reason: ExitReason, snapshot: MarketSnapshot): ClosedTrade[] {
    const trade = this.closePosition(symbol, reason, snapshot);
    return trade ? [trade] : [];
  }

  private fillPrice(snapshot: MarketSnapshot, side: 'BUY' | 'SELL'): number {
    const halfSpread = (snapshot.spreadPct / 100) * snapshot.price * 0.5;
    const noise = this.rng.range(0, this.options.slippageBps / 10_000) * snapshot.price;
    const price = side === 'BUY' ? snapshot.price + halfSpread + noise : snapshot.price - halfSpread - noise;
    return assertFiniteNumber(Math.max(0.0001, price), 'fill price');
  }

  private checkCircuitBreaker(): void {
    if (this.halted) return;
    const equity = this.equityUsd();
    const drawdownPct = ((this.dailyStartEquityUsd - equity) / this.dailyStartEquityUsd) * 100;
    if (drawdownPct >= this.limits.maxDailyLossPct) {
      this.halted = true;
      this.haltedReason = `daily loss circuit breaker tripped at ${num(drawdownPct)}% (limit ${num(this.limits.maxDailyLossPct)}%), equity ${usd(equity)}`;    }
  }

  /** Manual reset of the daily baseline (e.g. simulated new day). */
  rollDay(): void {
    this.dailyStartEquityUsd = this.equityUsd();
    this.halted = false;
    this.haltedReason = null;
  }
}
