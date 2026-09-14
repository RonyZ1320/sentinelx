import assert from 'node:assert/strict';
import test from 'node:test';

import { RiskEngine } from '../src/agents/RiskEngine';
import { loadSettings } from '../src/config/settings';
import { makeAdversary, makePortfolio, makeSnapshot, makeThesis, MINUTE_MS, scan } from './helpers';
import { PortfolioState } from '../src/types';

const settings = loadSettings({ symbols: ['FAKEUSDT'] });
const risk = new RiskEngine(settings.risk);

function assess(overrides: {
  snapshot?: Partial<Parameters<typeof makeSnapshot>[0]>;
  thesis?: Partial<Parameters<typeof makeThesis>[0]>;
  adversary?: Partial<Parameters<typeof makeAdversary>[0]>;
  portfolio?: Partial<PortfolioState>;
} = {}) {
  const snapshot = makeSnapshot(overrides.snapshot);
  const thesis = makeThesis(overrides.thesis);
  const adversary = makeAdversary({ thesisId: thesis.id, ...overrides.adversary });
  const portfolio = makePortfolio(overrides.portfolio);
  return risk.assess({ thesis, adversary, report: scan(snapshot), portfolio });
}

test('approves and sizes a clean setup from the fixed risk budget', () => {
  // A wide stop makes the risk budget the binding constraint rather than the position cap.
  const result = assess({ thesis: { stopPrice: 94.5 } });
  assert.equal(result.approved, true);
  assert.equal(result.action, 'APPROVE');
  assert.ok(result.quantity > 0);

  const expectedRiskUsd = 10_000 * (settings.risk.maxRiskPerTradePct / 100);
  assert.ok(
    Math.abs(result.riskUsd - expectedRiskUsd) < expectedRiskUsd * 0.02,
    `risked ${result.riskUsd} should be ~${expectedRiskUsd}`,
  );
  const expectedQty = expectedRiskUsd / (100 * (result.stopDistancePct / 100));
  assert.ok(Math.abs(result.quantity - expectedQty) < 1e-6, 'quantity must follow entry/stop distance');
});

test('caps position notional at the equity percentage limit (REDUCE)', () => {
  // A tight stop would otherwise produce a huge notional.
  const result = assess({ thesis: { stopPrice: 99.9 } });
  const maxNotional = 10_000 * (settings.risk.maxPositionPctOfEquity / 100);
  assert.equal(result.action, 'REDUCE');
  assert.ok(result.limitsHit.includes('MAX_POSITION_PCT'));
  assert.ok(result.notionalUsd <= maxNotional + 1e-9, `${result.notionalUsd} must be <= ${maxNotional}`);
});

test('halves size when the adversary weakens the thesis', () => {
  const baseline = assess();
  const weakened = assess({ adversary: { verdict: 'WEAKEN' } });
  assert.equal(weakened.action, 'REDUCE');
  assert.ok(weakened.limitsHit.includes('ADVERSARY_WEAKEN'));
  assert.ok(weakened.quantity < baseline.quantity);
  assert.ok(Math.abs(weakened.quantity - baseline.quantity / 2) < baseline.quantity * 0.01);
});

test('vetoes when post-adversary confidence is below the floor', () => {
  const result = assess({ adversary: { adjustedConfidence: settings.risk.minConfidence - 0.01 } });
  assert.equal(result.action, 'VETO');
  assert.equal(result.approved, false);
  assert.equal(result.quantity, 0);
  assert.ok(result.limitsHit.includes('MIN_CONFIDENCE'));
});

test('vetoes when the adversary rejects the thesis outright', () => {
  const result = assess({ adversary: { verdict: 'REJECT', adjustedConfidence: 0.9 } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('ADVERSARY_REJECT'));
});

test('vetoes while the daily loss circuit breaker is active', () => {
  const result = assess({
    portfolio: { halted: true, haltedReason: 'daily loss limit hit' },
  });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('DAILY_LOSS_CIRCUIT_BREAKER'));
  assert.match(result.reasons.join(' '), /daily loss limit hit/);
});

test('vetoes when the maximum number of open positions is reached', () => {
  const openPositions = Array.from({ length: settings.risk.maxOpenPositions }, (_, index) => ({
    symbol: `OTHER${index}USDT`,
    side: 'LONG' as const,
    quantity: 1,
    entryPrice: 10,
    stopPrice: 9.9,
    targetPrice: 10.5,
    openedAt: 0,
    thesisId: `ths_${index}`,
    decisionId: `dec_${index}`,
    peakPrice: 10,
    feesPaidUsd: 0.01,
  }));
  const result = assess({ portfolio: { openPositions } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('MAX_OPEN_POSITIONS'));
});

test('vetoes pyramiding into an existing position on the same symbol', () => {
  const result = assess({
    portfolio: {
      openPositions: [
        {
          symbol: 'FAKEUSDT',
          side: 'LONG',
          quantity: 1,
          entryPrice: 100,
          stopPrice: 99,
          targetPrice: 103,
          openedAt: 0,
          thesisId: 'ths_old',
          decisionId: 'dec_old',
          peakPrice: 100,
          feesPaidUsd: 0.01,
        },
      ],
    },
  });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('MAX_ONE_POSITION_PER_SYMBOL'));
});

test('vetoes when the spread is too wide to execute safely', () => {
  const result = assess({ snapshot: { spreadPct: settings.risk.maxSpreadPct + 0.1 } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('MAX_SPREAD'));
});

test('vetoes when the move is already extended (no chasing)', () => {
  const result = assess({ snapshot: { changePctBar: settings.risk.maxChaseMovePct + 1 } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('MAX_CHASE_MOVE'));
});

test('vetoes an inverted or zero stop', () => {
  const result = assess({ thesis: { stopPrice: 100 } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('INVALID_STOP'));
});

test('vetoes sizes below the minimum notional', () => {
  const result = assess({ portfolio: { cashUsd: 5, equityUsd: 5 } });
  assert.equal(result.action, 'VETO');
  assert.ok(result.limitsHit.includes('MIN_NOTIONAL') || result.limitsHit.includes('AVAILABLE_CASH'));
});

test('never sizes above available cash', () => {
  const result = assess({ portfolio: { cashUsd: 30, equityUsd: 2_000 } });
  assert.equal(result.approved, true);
  assert.ok(result.notionalUsd <= 30, `notional ${result.notionalUsd} must fit in cash`);
  assert.ok(result.limitsHit.includes('AVAILABLE_CASH'));
});

test('vetoes re-entry during the cooldown window after a close', () => {
  const closedAt = 1_700_000_000_000;
  const snapshot = makeSnapshot({ timestamp: closedAt + 5 * MINUTE_MS });
  const blocked = assess({
    snapshot,
    portfolio: { lastCloseAt: { FAKEUSDT: closedAt } },
  });
  assert.equal(blocked.action, 'VETO');
  assert.ok(blocked.limitsHit.includes('RE_ENTRY_COOLDOWN'));

  const afterCooldown = closedAt + (settings.risk.reEntryCooldownMinutes + 1) * MINUTE_MS;
  const allowed = assess({
    snapshot: makeSnapshot({ timestamp: afterCooldown }),
    portfolio: { lastCloseAt: { FAKEUSDT: closedAt } },
  });
  assert.equal(allowed.approved, true, allowed.reasons.join(' '));
});

test('reports every limit it hit for the journal', () => {
  const result = assess({ adversary: { verdict: 'WEAKEN' }, thesis: { stopPrice: 99.95 } });
  assert.ok(result.limitsHit.length >= 2);
  assert.ok(result.reasons.length >= 2);
  assert.equal(typeof result.id, 'string');
  assert.ok(result.id.startsWith('rsk_'));
});
