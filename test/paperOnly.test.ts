import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PaperBroker } from '../src/execution/PaperBroker';
import { loadSettings } from '../src/config/settings';
import { createDataLayer } from '../src/data';
import { makeDecision, makeSnapshot, makeThesis, tempStorage } from './helpers';
import { SentinelXError } from '../src/util';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `fn`, asserts it threw, and returns the thrown error. */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (cause) {
    return cause;
  }
  throw new assert.AssertionError({ message: 'Expected the function to throw, but it returned' });
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) found.push(full);
  }
  return found;
}

test('paper is the only supported mode', () => {
  const settings = withEnv({ SENTINELX_MODE: undefined }, () => loadSettings());
  assert.equal(settings.mode, 'paper');
});

test('an explicit paper mode is accepted', () => {
  const settings = withEnv({ SENTINELX_MODE: 'paper' }, () => loadSettings());
  assert.equal(settings.mode, 'paper');
});

for (const mode of ['live', 'real', 'prod', 'demo', 'margin']) {
  test(`SENTINELX_MODE=${mode} fails with LIVE_TRADING_DISABLED`, () => {
    const error = withEnv({ SENTINELX_MODE: mode }, () => captureThrow(() => loadSettings()));
    assert.ok(error instanceof SentinelXError, 'expected a SentinelXError');
    assert.equal(error.code, 'LIVE_TRADING_DISABLED');
    assert.match(error.message, /PAPER TRADING ONLY/i);
  });
}

test('enabling the live escape hatch throws before any order is simulated', () => {
  const settings = loadSettings();
  const broker = new PaperBroker(settings.risk, { startingEquityUsd: 10_000 }, 1);

  const error = withEnv({ SENTINELX_ALLOW_LIVE: 'true' }, () =>
    captureThrow(() => broker.openLong(makeDecision(), makeThesis(), makeSnapshot())),
  );
  assert.ok(error instanceof SentinelXError);
  assert.equal(error.code, 'LIVE_TRADING_DISABLED');
  assert.equal(broker.portfolio().openPositions.length, 0, 'no position may be opened');
});

test('the same order path succeeds once the escape hatch is removed', () => {
  const settings = loadSettings();
  const broker = new PaperBroker(settings.risk, { startingEquityUsd: 10_000 }, 1);
  const opened = withEnv({ SENTINELX_ALLOW_LIVE: undefined }, () =>
    broker.openLong(makeDecision(), makeThesis(), makeSnapshot()),
  );
  assert.ok(opened, 'paper fill should succeed');
  assert.equal(broker.portfolio().openPositions.length, 1);
});

test('the default data layer is simulated', () => {
  const storage = tempStorage('paper-only');
  try {
    const settings = loadSettings({ storageDir: storage.dir });
    const data = createDataLayer(settings);
    assert.equal(data.market.isSimulated, true);
    assert.equal(data.events.isSimulated, true);
    assert.equal(data.market.name, 'mock-market');
    assert.equal(data.events.name, 'mock-events');
  } finally {
    storage.cleanup();
  }
});

test('no source file performs network I/O', () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bnew\s+WebSocket\b/,
    /require\(\s*['"](https?|net|dgram|tls)['"]\s*\)/,
    /from\s+['"](https?|net|dgram|tls|axios|ccxt|ws)['"]/,
    /\bXMLHttpRequest\b/,
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const body = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(body)) offenders.push(`${file} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'SentinelX v0.1 must not touch the network');
});

test('package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies, undefined, 'no runtime deps: nothing can reach an exchange');
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@types/node', 'typescript']);
});

test('.env.example ships without credentials', () => {
  const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  for (const line of example.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, value] = trimmed.split('=');
    if (/KEY|SECRET|PASSPHRASE|TOKEN/.test(key ?? '')) {
      assert.equal((value ?? '').trim(), '', `${key} must be empty in .env.example`);
    }
  }
  assert.match(example, /SENTINELX_MODE=paper/);
});
