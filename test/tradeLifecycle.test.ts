import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { TradingPipeline } from '../src/pipeline/TradingPipeline';
import { StrategyMemory } from '../src/memory/StrategyMemory';
import { TradeJournal } from '../src/journal/TradeJournal';
import { createDataLayer } from '../src/data';
import { loadSettings } from '../src/config/settings';
import { JournalEntry } from '../src/types';
import {
  FAKE_START,
  FakeDataLayer,
  FakeScript,
  makeEvent,
  makeSnapshot,
  MINUTE_MS,
  tempStorage,
} from './helpers';

const ENTRY = makeSnapshot({ symbol: 'FAKEUSDT', price: 100 });
const CATALYST = makeEvent({ symbol: 'FAKEUSDT' });

function buildPipeline(storageDir: string, ticks: FakeScript) {
  const settings = loadSettings({
    symbols: ['FAKEUSDT'],
    storageDir,
    cycles: ticks.length,
    seed: 11,
    startingEquityUsd: 10_000,
  });
  return { settings, pipeline: new TradingPipeline(settings, new FakeDataLayer(ticks, ['FAKEUSDT'])) };
}

function payloadOf<T>(entries: JournalEntry[], kind: JournalEntry['kind'], index = 0): T {
  const match = entries.filter((entry) => entry.kind === kind)[index];
  assert.ok(match, `journal is missing a ${kind} entry`);
  return match.payload as T;
}

test('a valid setup passes the whole critique loop into the PaperBroker', async () => {
  const storage = tempStorage('lifecycle-entry');
  try {
    const { pipeline } = buildPipeline(storage.dir, [
      { snapshots: [ENTRY], events: [CATALYST] },
      { snapshots: [makeSnapshot({ symbol: 'FAKEUSDT', price: 100.5 })] },
    ]);

    const outcome = await pipeline.runCycle(1);
    const decision = outcome.decisions[0];
    assert.ok(decision, 'a decision must be produced');
    assert.equal(decision.action, 'BUY');
    assert.equal(decision.symbol, 'FAKEUSDT');
    assert.ok(decision.quantity > 0);
    assert.ok(decision.rationale.length >= 3, 'decision must carry its reasoning');
    assert.ok(decision.thesisId && decision.adversaryReportId && decision.riskAssessmentId);

    const chain = outcome.chains[0];
    assert.ok(chain);
    assert.equal(chain.report.bias, 'LONG');
    assert.ok(chain.thesis, 'Thesis Engine must propose a thesis');
    assert.ok(chain.adversary, 'Adversary Agent must challenge it');
    assert.notEqual(chain.adversary.verdict, 'REJECT');
    assert.ok(chain.risk?.approved, `risk vetoed: ${chain.risk?.reasons.join(' ')}`);

    assert.equal(outcome.fills.length, 1, 'exactly one simulated fill');
    const fill = outcome.fills[0];
    assert.ok(fill);
    assert.equal(fill.side, 'BUY');
    assert.ok(fill.feeUsd > 0, 'paper fills must charge fees');

    const portfolio = pipeline.broker.portfolio();
    assert.equal(portfolio.openPositions.length, 1);
    assert.equal(portfolio.openPositions[0]?.symbol, 'FAKEUSDT');
    assert.ok(portfolio.cashUsd < portfolio.startingEquityUsd, 'cash must be committed');
    assert.ok(
      portfolio.cashUsd > portfolio.startingEquityUsd * 0.85,
      'a single trade must not commit most of the account',
    );
    assert.equal(portfolio.halted, false);
  } finally {
    storage.cleanup();
  }
});

test('the journal records the decision and the execution on disk', async () => {
  const storage = tempStorage('lifecycle-journal');
  try {
    const { settings, pipeline } = buildPipeline(storage.dir, [
      { snapshots: [ENTRY], events: [CATALYST] },
      { snapshots: [makeSnapshot({ symbol: 'FAKEUSDT', price: 100.5 })] },
    ]);

    await pipeline.runCycle(1);

    const journalPath = join(settings.storageDir, 'journal.jsonl');
    assert.ok(existsSync(journalPath), 'journal.jsonl must exist');

    const entries = TradeJournal.read(journalPath);
    assert.ok(entries.length >= 3, 'cycle + decision + fill expected');

    const decision = payloadOf<{ decision: { action: string; symbol: string } }>(entries, 'DECISION');
    assert.equal(decision.decision.action, 'BUY');
    assert.equal(decision.decision.symbol, 'FAKEUSDT');

    const fill = payloadOf<{ side: string; quantity: number; price: number }>(entries, 'FILL');
    assert.equal(fill.side, 'BUY');
    assert.ok(fill.quantity > 0 && fill.price > 0);

    const cycle = payloadOf<{ decisions: unknown[] }>(entries, 'CYCLE');
    assert.equal(cycle.decisions.length, 1);

    // Every line must be independently parseable JSON (append-only contract).
    for (const line of readFileSync(journalPath, 'utf8').trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(line));
    }

    const stats = pipeline.journal.stats();
    assert.equal(stats.buys, 1);
    assert.equal(stats.decisions, 1);
  } finally {
    storage.cleanup();
  }
});

test('a winning close produces an autopsy lesson stored in StrategyMemory', async () => {
  const storage = tempStorage('lifecycle-win');
  try {
    const { settings, pipeline } = buildPipeline(storage.dir, [
      { snapshots: [ENTRY], events: [CATALYST] },
      // Bar 2 gaps through the take-profit target.
      { snapshots: [makeSnapshot({ symbol: 'FAKEUSDT', price: 104 })] },
    ]);

    const first = await pipeline.runCycle(1);
    assert.equal(first.fills.length, 1);
    const second = await pipeline.runCycle(2);

    assert.equal(second.closedTrades.length, 1, 'target should have closed the position');
    const trade = second.closedTrades[0];
    assert.ok(trade);
    assert.equal(trade.exitReason, 'TARGET_HIT');
    assert.ok(trade.pnlUsd > 0, `expected a paper profit, got ${trade.pnlUsd}`);
    assert.equal(pipeline.broker.portfolio().openPositions.length, 0);

    const autopsy = second.autopsies[0];
    assert.ok(autopsy, 'autopsy must review the closed trade');
    assert.equal(autopsy.tradeId, trade.id);
    assert.ok(['A', 'B', 'C', 'D', 'F'].includes(autopsy.grade));
    assert.ok(autopsy.wentRight.length > 0);
    assert.ok(autopsy.lesson.id.startsWith('lsn_'));
    assert.ok(autopsy.lesson.statement.length > 10);
    assert.equal(autopsy.lesson.tag, 'POSITIVE_PATTERN');
    assert.ok(autopsy.lesson.weight > 0);

    const lessons = pipeline.memory.relevantLessons('FAKEUSDT');
    assert.ok(lessons.length >= 1, 'lesson must be stored in strategy memory');
    assert.ok(pipeline.memory.adjustmentFor('FAKEUSDT') > 0, 'a good outcome should raise confidence');

    const memoryPath = join(settings.storageDir, 'memory.json');
    assert.ok(existsSync(memoryPath), 'memory.json must exist');
    const reloaded = new StrategyMemory(settings.storageDir);
    assert.equal(reloaded.size(), lessons.length, 'memory must survive a reload');
    assert.ok(reloaded.adjustmentFor('FAKEUSDT') > 0);

    const entries = TradeJournal.read(join(settings.storageDir, 'journal.jsonl'));
    const closed = payloadOf<{ autopsy: { lesson: { tag: string } } }>(entries, 'TRADE_CLOSED');
    assert.equal(closed.autopsy.lesson.tag, 'POSITIVE_PATTERN');
  } finally {
    storage.cleanup();
  }
});

test('a stopped-out close is graded and penalises the same setup later', async () => {
  const storage = tempStorage('lifecycle-loss');
  try {
    const { pipeline } = buildPipeline(storage.dir, [
      { snapshots: [ENTRY], events: [CATALYST] },
      // Bar 2 breaks the stop immediately: the catalyst faded.
      { snapshots: [makeSnapshot({ symbol: 'FAKEUSDT', price: 97 })] },
    ]);

    await pipeline.runCycle(1);
    const second = await pipeline.runCycle(2);
    const trade = second.closedTrades[0];
    assert.ok(trade);
    assert.equal(trade.exitReason, 'STOP_HIT');
    assert.ok(trade.pnlUsd < 0, 'a stopped-out trade must lose money');

    const autopsy = second.autopsies[0];
    assert.ok(autopsy);
    assert.ok(autopsy.mistakes.length > 0, 'a fast stop-out must be tagged as a mistake');
    assert.ok(autopsy.lesson.weight < 0, 'the lesson must be negative');

    const tags = autopsy.mistakes;
    assert.ok(
      pipeline.memory.adjustmentFor('FAKEUSDT', tags) < 0,
      'the stored lesson must reduce confidence for the same pattern',
    );
    assert.ok((trade.closedAt - trade.openedAt) / MINUTE_MS >= 0);
    assert.ok(trade.openedAt >= FAKE_START);
  } finally {
    storage.cleanup();
  }
});

test('the risk engine veto keeps the pipeline flat and is journalled as HOLD', async () => {
  const storage = tempStorage('lifecycle-veto');
  try {
    const { pipeline } = buildPipeline(storage.dir, [
      {
        // Uncrossable spread: the Risk Engine must refuse the trade.
        snapshots: [makeSnapshot({ symbol: 'FAKEUSDT', spreadPct: 1.5 })],
        events: [CATALYST],
      },
    ]);

    const outcome = await pipeline.runCycle(1);
    const chain = outcome.chains[0];
    assert.ok(chain);
    assert.equal(chain.risk?.approved, false);
    assert.ok(chain.risk?.limitsHit.includes('MAX_SPREAD'));
    assert.equal(outcome.decisions[0]?.action, 'HOLD');
    assert.equal(outcome.fills.length, 0);
    assert.equal(pipeline.broker.portfolio().openPositions.length, 0);
    assert.equal(pipeline.broker.portfolio().cashUsd, 10_000);
    assert.equal(pipeline.journal.stats().holds, 1);
  } finally {
    storage.cleanup();
  }
});

test('the shipped mock data layer also drives the pipeline without touching the network', async () => {
  const storage = tempStorage('lifecycle-mock');
  try {
    const settings = loadSettings({
      symbols: ['BTCUSDT'],
      storageDir: storage.dir,
      cycles: 3,
      seed: 1337,
    });
    const pipeline = new TradingPipeline(settings, createDataLayer(settings));

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const outcome = await pipeline.runCycle(cycle);
      assert.equal(outcome.decisions.length, 1);
      assert.ok(['BUY', 'SELL', 'HOLD'].includes(outcome.decisions[0]?.action ?? ''));
    }

    const { closedTrades } = await pipeline.finish(4);
    assert.equal(pipeline.broker.portfolio().openPositions.length, 0);
    assert.ok(closedTrades.every((trade) => Number.isFinite(trade.pnlUsd)));
    assert.ok(pipeline.journal.stats().decisions >= 3);
  } finally {
    storage.cleanup();
  }
});
