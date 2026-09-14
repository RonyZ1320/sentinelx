import { AdversaryAgent } from '../agents/AdversaryAgent';
import { DecisionEngine } from '../agents/DecisionEngine';
import { RiskEngine } from '../agents/RiskEngine';
import { ScoutAgent } from '../agents/ScoutAgent';
import { ThesisEngine } from '../agents/ThesisEngine';
import { SentinelXSettings } from '../config/settings';
import { DataLayer } from '../data';
import { PaperBroker } from '../execution/PaperBroker';
import { TradeJournal } from '../journal/TradeJournal';
import { StrategyMemory } from '../memory/StrategyMemory';
import { PendingDossier, TradeAutopsy } from '../autopsy/TradeAutopsy';
import {
  AdversaryReport,
  AutopsyReport,
  ClosedTrade,
  MarketSnapshot,
  NewsEvent,
  PaperFill,
  RiskAssessment,
  ScoutReport,
  Thesis,
  TradeDecision,
} from '../types';
import { SentinelXError } from '../util';

/** The full reasoning chain for one symbol in one cycle. */
export interface AgentChain {
  report: ScoutReport;
  thesis: Thesis | null;
  adversary: AdversaryReport | null;
  risk: RiskAssessment | null;
  decision: TradeDecision;
}

export interface CycleOutcome {
  cycle: number;
  timestamp: number;
  chains: AgentChain[];
  reports: ScoutReport[];
  decisions: TradeDecision[];
  fills: PaperFill[];
  closedTrades: ClosedTrade[];
  autopsies: AutopsyReport[];
  halted: boolean;
  haltedReason: string | null;
}

/** Rolling window of news the Scout is allowed to consider. */
const EVENT_MEMORY_MS = 20 * 60 * 1000;

/**
 * TradingPipeline — wires the whole critique loop together:
 *
 *   Scout -> Thesis -> Adversary -> Risk -> Decision -> Paper Execution
 *          -> Journal -> Autopsy -> Strategy Memory -> (next cycle)
 */
export class TradingPipeline {
  readonly scout: ScoutAgent;
  readonly thesisEngine: ThesisEngine;
  readonly adversary: AdversaryAgent;
  readonly riskEngine: RiskEngine;
  readonly decisionEngine: DecisionEngine;
  readonly broker: PaperBroker;
  readonly journal: TradeJournal;
  readonly memory: StrategyMemory;
  readonly autopsy: TradeAutopsy;

  private readonly data: DataLayer;
  private readonly eventBuffer: NewsEvent[] = [];
  private readonly dossiers = new Map<string, PendingDossier>();

  constructor(settings: SentinelXSettings, data: DataLayer) {
    this.data = data;
    this.memory = new StrategyMemory(settings.storageDir);
    this.journal = new TradeJournal(settings.storageDir);
    this.scout = new ScoutAgent();
    this.thesisEngine = new ThesisEngine(this.memory, settings.risk);
    this.adversary = new AdversaryAgent(this.memory, settings.risk);
    this.riskEngine = new RiskEngine(settings.risk);
    this.decisionEngine = new DecisionEngine();
    this.broker = new PaperBroker(
      settings.risk,
      {
        startingEquityUsd: settings.startingEquityUsd,
        barMinutes: data.world.barMinutes(),
      },
      settings.seed,
    );
    this.autopsy = new TradeAutopsy(this.memory, settings.risk);
  }

  symbols(): string[] {
    return this.data.market.symbols();
  }

  async runCycle(cycle: number): Promise<CycleOutcome> {
    try {
      await this.data.market.tick();
      const now = this.data.world.now();
      const snapshots = await this.data.market.getSnapshots(this.symbols());
      const freshEvents = await this.data.events.poll(this.symbols());

      this.eventBuffer.push(...freshEvents);
      this.pruneEvents(now);

      const fills: PaperFill[] = [];
      const closedTrades: ClosedTrade[] = [];
      const autopsies: AutopsyReport[] = [];
      const chains: AgentChain[] = [];

      // 1) Risk management on existing positions.
      for (const snapshot of snapshots) {
        for (const closed of this.broker.manage(snapshot)) {
          closedTrades.push(closed);
          const autopsy = this.reviewClosed(closed);
          if (autopsy) autopsies.push(autopsy);
          this.journal.recordTradeClosed(cycle, closed, autopsy);
        }
      }

      // 2) Full critique loop per symbol.
      for (const snapshot of snapshots) {
        const events = this.eventsFor(snapshot.symbol, now);
        const report = this.scout.scan(snapshot, events, now);

        const thesis = this.thesisEngine.build(report);
        const adversaryReport = thesis ? this.adversary.challenge(thesis, report) : null;
        const risk =
          thesis && adversaryReport
            ? this.riskEngine.assess({
                thesis,
                adversary: adversaryReport,
                report,
                portfolio: this.broker.portfolio(),
              })
            : null;

        const decision = this.decisionEngine.decide({
          cycle,
          timestamp: now,
          report,
          thesis,
          adversary: adversaryReport,
          risk,
          portfolio: this.broker.portfolio(),
        });
        chains.push({ report, thesis, adversary: adversaryReport, risk, decision });
        this.journal.recordDecision(decision, this.broker.portfolio());

        const executed = this.execute(decision, thesis, adversaryReport, risk, report, snapshot);
        fills.push(...executed);
      }

      const portfolio = this.broker.portfolio();
      if (portfolio.halted && portfolio.haltedReason) {
        this.journal.recordRiskHalt(cycle, now, portfolio.haltedReason);
      }

      this.journal.recordCycle(cycle, now, {
        reports: chains.map((chain) => chain.report).map((report) => ({
          symbol: report.symbol,
          bias: report.bias,
          opportunityScore: report.opportunityScore,
          events: report.events.length,
          anomalies: report.anomalies.map((anomaly) => anomaly.type),
          price: report.snapshot.price,
        })),
        decisions: chains.map((chain) => chain.decision).map((decision) => ({
          symbol: decision.symbol,
          action: decision.action,
          quantity: decision.quantity,
          confidence: decision.confidence,
        })),
        fills: fills.map((fill) => ({ symbol: fill.symbol, side: fill.side, quantity: fill.quantity })),
        portfolio: { equityUsd: portfolio.equityUsd, cashUsd: portfolio.cashUsd },
      });

      return {
        cycle,
        timestamp: now,
        chains,
        reports: chains.map((chain) => chain.report),
        decisions: chains.map((chain) => chain.decision),
        fills,
        closedTrades,
        autopsies,
        halted: portfolio.halted,
        haltedReason: portfolio.haltedReason,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SentinelXError(`Cycle ${cycle} failed: ${message}`, 'CYCLE_FAILED');
    }
  }

  /** Flatten all open positions at the end of the simulation. */
  async finish(cycle: number): Promise<{ closedTrades: ClosedTrade[]; autopsies: AutopsyReport[] }> {
    const snapshots = await this.data.market.getSnapshots(this.symbols());
    const closedTrades = this.broker.closeAll(snapshots, 'END_OF_SIMULATION');
    const autopsies: AutopsyReport[] = [];
    for (const trade of closedTrades) {
      const autopsy = this.reviewClosed(trade);
      if (autopsy) autopsies.push(autopsy);
      this.journal.recordTradeClosed(cycle, trade, autopsy);
    }
    return { closedTrades, autopsies };
  }

  private execute(
    decision: TradeDecision,
    thesis: Thesis | null,
    adversary: AdversaryReport | null,
    risk: RiskAssessment | null,
    report: ScoutReport,
    snapshot: MarketSnapshot,
  ): PaperFill[] {
    if (decision.action === 'HOLD' || !thesis || !risk) return [];

    if (decision.action === 'BUY') {
      const opened = this.broker.openLong(decision, thesis, snapshot);
      if (!opened) return [];
      this.dossiers.set(thesis.id, {
        thesis,
        adversary,
        risk,
        decision,
        entrySnapshot: report.snapshot,
      });
      this.journal.recordFill(decision.cycle, opened.fill);
      return [opened.fill];
    }

    // SELL only ever closes an existing paper position (long-only, no leverage).
    if (!this.broker.hasPosition(decision.symbol)) return [];
    const closed = this.broker.closePosition(decision.symbol, 'SIGNAL_EXIT', snapshot);
    if (!closed) return [];
    const autopsy = this.reviewClosed(closed);
    this.journal.recordTradeClosed(decision.cycle, closed, autopsy);
    return [];
  }

  private reviewClosed(trade: ClosedTrade): AutopsyReport | null {
    const dossier = this.dossiers.get(trade.thesisId);
    this.dossiers.delete(trade.thesisId);
    if (!dossier) return null;
    try {
      return this.autopsy.review({ ...dossier, trade });
    } catch (cause) {
      process.stderr.write(
        `[sentinelx] autopsy failed for ${trade.id}: ${(cause as Error).message}\n`,
      );
      return null;
    }
  }

  private eventsFor(symbol: string, now: number): NewsEvent[] {
    return this.eventBuffer.filter(
      (event) =>
        (event.symbol === symbol || event.symbol === 'MARKET') &&
        now - event.timestamp <= EVENT_MEMORY_MS,
    );
  }

  private pruneEvents(now: number): void {
    for (let i = this.eventBuffer.length - 1; i >= 0; i -= 1) {
      const event = this.eventBuffer[i];
      if (event && now - event.timestamp > EVENT_MEMORY_MS) this.eventBuffer.splice(i, 1);
    }
  }
}
