#!/usr/bin/env node
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

import { loadSettings, SentinelXSettings } from './config/settings';
import { createDataLayer } from './data';
import { TradingPipeline } from './pipeline/TradingPipeline';
import { TradeJournal } from './journal/TradeJournal';
import {
  banner,
  cycleHeader,
  formatAutopsy,
  formatClosedTrade,
  formatDecision,
  formatFillLine,
  formatLessons,
  formatRisk,
  formatScout,
  formatSummary,
  formatThesis,
  rule,
} from './cli/report';
import { Lesson } from './types';
import { num, SentinelXError, usd } from './util';

interface CliOptions {
  cycles: number;
  seed: number;
  symbols?: string[];
  equity?: number;
  verbose: boolean;
  quiet: boolean;
  reset: boolean;
  command: 'run' | 'review' | 'help';
}

const HELP = `
SentinelX — self-critic autonomous trading agent (PAPER TRADING ONLY)

Usage:
  sentinelx [command] [options]

Commands:
  run       Run a local demo session (default)
  review    Print stats from the last recorded trade journal
  help      Show this message

Options:
  --cycles <n>       Number of 5-minute bars to simulate (default 24)
  --seed <n>         RNG seed for a reproducible demo (default 1337)
  --symbols <list>   Comma separated universe (default AAPL,NVDA,TSLA,MSFT,AMZN,META,GOOGL,AMD)
  --equity <usd>     Starting paper equity (default 10000)
  --verbose          Print the full reasoning chain for every symbol
  --quiet            Print only fills, closes and the final summary
  --reset            Delete .sentinelx/ (journal + strategy memory) before running

Examples:
  npm start
  node dist/cli.js --cycles 40 --seed 7 --verbose
  node dist/cli.js review
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { cycles: 0, seed: 0, verbose: false, quiet: false, reset: false, command: 'run' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new SentinelXError(`Missing value for ${arg}`, 'BAD_CLI_ARG');
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--cycles':
        options.cycles = Math.max(1, Number(next()) || 1);
        break;
      case '--seed':
        options.seed = Math.round(Number(next()) || 1);
        break;
      case '--symbols':
        options.symbols = next()
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter((symbol) => symbol.length > 0);
        break;
      case '--equity':
        options.equity = Math.max(100, Number(next()) || 100);
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--reset':
        options.reset = true;
        break;
      case '--help':
      case '-h':
        options.command = 'help';
        break;
      case 'run':
        options.command = 'run';
        break;
      case 'review':
        options.command = 'review';
        break;
      case 'help':
        options.command = 'help';
        break;
      default:
        throw new SentinelXError(`Unknown argument: ${arg}`, 'BAD_CLI_ARG');
    }
  }
  return options;
}

function buildSettings(options: CliOptions): SentinelXSettings {
  return loadSettings({
    ...(options.cycles > 0 ? { cycles: options.cycles } : {}),
    ...(options.seed !== 0 ? { seed: options.seed } : {}),
    ...(options.symbols ? { symbols: options.symbols } : {}),
    ...(options.equity ? { startingEquityUsd: options.equity } : {}),
    verbose: options.verbose,
  });
}

async function runDemo(settings: SentinelXSettings, options: CliOptions): Promise<number> {
  if (options.reset) {
    rmSync(resolve(settings.storageDir), { recursive: true, force: true });
  }

  const data = createDataLayer(settings);
  const pipeline = new TradingPipeline(settings, data);
  const log = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  log(
    banner([
      'SentinelX - self-critic autonomous trading agent',
      'Bitget AI Base Camp Hackathon S2 | Agentic Trading | Event-Driven Agent',
      '',
      'MODE: PAPER TRADING ONLY - no API keys, no network, no real orders.',
      `universe ${settings.symbols.join(', ')}   equity ${usd(settings.startingEquityUsd)}   cycles ${settings.cycles}   seed ${settings.seed}`,
      `risk: ${num(settings.risk.maxRiskPerTradePct)}%/trade | ${num(settings.risk.maxPositionPctOfEquity)}%/position | ${settings.risk.maxOpenPositions} max open | ${num(settings.risk.maxDailyLossPct)}% daily halt | ${settings.risk.maxLeverage}x leverage`,
    ]),
  );

  if (settings.liveCredentialsConfigured) {
    log(
      '\n[notice] Exchange/news credentials were detected in the environment. SentinelX v0.1 ignores them and keeps running fully simulated.\n',
    );
  }

  let haltedAnnounced = false;

  for (let cycle = 1; cycle <= settings.cycles; cycle += 1) {
    const outcome = await pipeline.runCycle(cycle);
    const portfolio = pipeline.broker.portfolio();

    if (!options.quiet) log(cycleHeader(cycle, outcome.timestamp, portfolio));

    for (const chain of outcome.chains) {
      const interesting =
        chain.report.opportunityScore >= 0.35 || chain.decision.action !== 'HOLD';
      if (options.quiet) continue;
      if (!options.verbose && !interesting) continue;

      log(formatScout(chain.report));
      if (options.verbose || chain.thesis) {
        log(formatThesis(chain.thesis, chain.adversary));
        log(formatRisk(chain.risk));
      }
      log(formatDecision(chain.decision));
    }

    for (const fill of outcome.fills) {
      log(formatFillLine(fill.symbol, fill.side, fill.quantity, fill.price, fill.feeUsd));
    }

    outcome.closedTrades.forEach((trade) => {
      log(formatClosedTrade(trade));
      const autopsy = outcome.autopsies.find((item) => item.tradeId === trade.id);
      if (autopsy) log(formatAutopsy(autopsy));
    });

    if (outcome.halted && !haltedAnnounced) {
      haltedAnnounced = true;
      log(rule('!'));
      log(`  RISK CIRCUIT BREAKER: ${outcome.haltedReason}`);
      log(rule('!'));
    }
  }

  const finalCycle = settings.cycles + 1;
  const { closedTrades, autopsies } = await pipeline.finish(finalCycle);
  for (const trade of closedTrades) {
    log(formatClosedTrade(trade));
    const autopsy = autopsies.find((item) => item.tradeId === trade.id);
    if (autopsy) log(formatAutopsy(autopsy));
  }

  const stats = pipeline.journal.stats();
  const lessons = pipeline.symbols()
    .flatMap((symbol) => pipeline.memory.relevantLessons(symbol, 4))
    .filter((lesson, index, all) => all.findIndex((item) => item.id === lesson.id) === index);

  log('');
  log(
    formatSummary(
      pipeline.broker.portfolio(),
      stats,
      [...pipeline.broker.history().closedTrades],
      lessons,
      settings.cycles,
      data.world.barMinutes(),
    ),
  );

  return stats.decisions > 0 ? 0 : 1;
}

function reviewJournal(settings: SentinelXSettings): number {
  const filePath = resolve(settings.storageDir, 'journal.jsonl');
  const entries = TradeJournal.read(filePath);
  if (entries.length === 0) {
    process.stdout.write(`No journal found at ${filePath}. Run a demo first: npm start\n`);
    return 0;
  }

  const decisions = entries.filter((entry) => entry.kind === 'DECISION');
  const closed = entries.filter((entry) => entry.kind === 'TRADE_CLOSED');
  process.stdout.write(
    [
      rule('='),
      `SENTINELX JOURNAL REVIEW — ${filePath}`,
      rule('='),
      `  entries           ${entries.length}`,
      `  decisions logged  ${decisions.length}`,
      `  trades closed     ${closed.length}`,
      '',
      '  LAST 10 DECISIONS',
      ...decisions
        .slice(-10)
        .map((entry) => {
          const payload = entry.payload as { decision?: { action?: string; symbol?: string; quantity?: number } };
          return `    cycle ${String(entry.cycle).padStart(3)}  ${payload.decision?.action ?? '?'} ${payload.decision?.symbol ?? ''}`;
        }),
      '',
      '  STORED LESSONS',
      formatLessons(
        closed
          .map((entry) => (entry.payload as { autopsy?: { lesson?: Lesson } }).autopsy?.lesson)
          .filter((lesson): lesson is Lesson => Boolean(lesson)),
      ),
      rule('='),
    ].join('\n'),
  );
  return 0;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  const settings = buildSettings(options);
  if (options.command === 'review') return reviewJournal(settings);
  return runDemo(settings, options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`\n[sentinelx] fatal: ${message}\n`);
    if (process.env.SENTINELX_DEBUG === 'true' && cause instanceof Error) {
      process.stderr.write(`${cause.stack ?? ''}\n`);
    }
    process.exitCode = 1;
  });
