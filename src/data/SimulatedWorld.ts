import { EventCategory, MarketSnapshot, NewsEvent, Symbol_ } from '../types';
import { Rng, clamp, newId, safeDivide } from '../util';

const BAR_MINUTES = 5;
const BARS_PER_DAY = (24 * 60) / BAR_MINUTES;

interface ShockState {
  /** Remaining signed impact in percent, decays each bar. */
  remainingPct: number;
  decay: number;
}

interface SymbolState {
  price: number;
  avgVolume20d: number;
  volume24h: number;
  returns: number[];
  shock: ShockState;
  openInterest: number;
  liquidations24h: number;
  spreadPct: number;
}

const EVENT_TEMPLATES: ReadonlyArray<{
  category: EventCategory;
  bullish: string[];
  bearish: string[];
}> = [
  {
    category: 'REGULATION',
    bullish: ['regulator clears spot ETF listing path', 'draft framework deemed industry-friendly'],
    bearish: ['regulator opens enforcement probe', 'new restrictive guidance circulated'],
  },
  {
    category: 'MACRO',
    bullish: ['softer CPI print lifts risk appetite', 'central bank signals easing bias'],
    bearish: ['hot inflation print crushes risk assets', 'yields spike, risk-off tone returns'],
  },
  {
    category: 'EARNINGS',
    bullish: ['quarterly earnings beat estimates with strong guidance', 'revenue and margins exceed expectations'],
    bearish: ['quarterly earnings miss estimates with weak guidance', 'revenue outlook falls below expectations'],
  },
  {
    category: 'PRODUCT',
    bullish: ['new product launch shows strong early demand', 'company announces major product breakthrough'],
    bearish: ['product launch faces delays and weak demand signals', 'company reports unexpected product setback'],
  },
  {
    category: 'ANALYST',
    bullish: ['major analyst upgrades the stock with higher price target', 'analyst raises estimates on improving outlook'],
    bearish: ['major analyst downgrades the stock with lower price target', 'analyst cuts estimates on weaker outlook'],
  },
  {
    category: 'SOCIAL',
    bullish: ['social volume surges with positive tone', 'prominent fund discloses new position'],
    bearish: ['viral thread alleges manipulation', 'sentiment flips sharply negative in one hour'],
  },
];

/**
 * Deterministic synthetic market used by the demo. It owns one RNG so market
 * data and news events stay causally linked (a shock produces both a price
 * move and a headline). Swapping in Bitget data means replacing the provider
 * and feed, not this file's consumers.
 */
export class SimulatedWorld {
  private readonly rng: Rng;
  private readonly states = new Map<string, SymbolState>();
  private pendingEvents: NewsEvent[] = [];
  private barIndex = 0;

  constructor(
    private readonly symbols: string[],
    seed: number,
    private readonly startTime = Date.UTC(2026, 8, 12, 9, 0, 0),
  ) {
    this.rng = new Rng(seed);
    for (const symbol of symbols) {
      this.states.set(symbol, {
        price: this.basePrice(symbol),
        avgVolume20d: this.rng.range(180_000_000, 900_000_000),
        volume24h: 0,
        returns: [],
        shock: { remainingPct: 0, decay: 0.55 },
        openInterest: this.rng.range(400_000_000, 1_600_000_000),
        liquidations24h: 0,
        spreadPct: this.rng.range(0.01, 0.06),
      });
    }
    // Warm up so volatility/volume baselines are populated before cycle 1.
    for (let i = 0; i < 20; i += 1) this.advance(true);
    this.pendingEvents = [];
  }

  private basePrice(symbol: string): number {
    const stockRanges: Record<string, [number, number]> = {
      AAPL: [220, 250],
      NVDA: [170, 230],
      TSLA: [300, 400],
      MSFT: [480, 550],
      AMZN: [200, 240],
      META: [700, 800],
      GOOGL: [230, 280],
      AMD: [140, 190],
    };

    const range = stockRanges[symbol];
    if (range) return this.rng.range(range[0], range[1]);

    return this.rng.range(50, 500);
  }

  /** Sim clock: one call = one bar of `BAR_MINUTES`. */
  now(): number {
    return this.startTime + this.barIndex * BAR_MINUTES * 60_000;
  }

  barMinutes(): number {
    return BAR_MINUTES;
  }

  tick(): void {
    this.advance(false);
  }

  drainEvents(): NewsEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  private advance(warmup: boolean): void {
    this.barIndex += 1;
    const timestamp = this.now();

    for (const symbol of this.symbols) {
      const state = this.states.get(symbol);
      if (!state) continue;

      // Random market-moving event.
      if (this.rng.chance(warmup ? 0.06 : 0.14)) {
        const template = this.rng.pick(EVENT_TEMPLATES);
        const bullish = this.rng.chance(0.5);
        const magnitudePct = this.rng.range(1.2, 5.5);
        state.shock.remainingPct = bullish ? magnitudePct : -magnitudePct;
        state.shock.decay = this.rng.range(0.45, 0.7);

        if (!warmup) {
          const lines = bullish ? template.bullish : template.bearish;
          this.pendingEvents.push({
            id: newId('evt'),
            symbol,
            headline: `${symbol.replace('USDT', '')}: ${this.rng.pick(lines)}`,
            category: template.category,
            sentiment: clamp((bullish ? 1 : -1) * this.rng.range(0.65, 0.95), -1, 1),
            credibility: this.rng.range(0.72, 0.98),
            timestamp,
            source: 'mock-wire',
          });
        }
      }

      const shockPart = state.shock.remainingPct;
      const noise = this.rng.range(-0.55, 0.55);
      const drift = this.rng.range(-0.08, 0.1);

      // Some bullish events resolve through a controlled pullback/recovery
      // rather than an immediate chaseable spike. This gives the agent
      // legitimate confirmation setups to evaluate.
      const recovery =
        shockPart > 0 && Math.abs(shockPart) < 2.2
          ? this.rng.range(-0.55, 0.25)
          : 0;

      // Keep the first event bar from becoming an automatic chase.
      // The remaining shock can then provide confirmation/continuation
      // on subsequent bars.
      const eventImpulse =
        Math.abs(shockPart) > 3.5
          ? shockPart * 0.28
          : shockPart * 0.38;

      const barReturnPct = eventImpulse + noise + drift + recovery;

      state.price = Math.max(0.0001, state.price * (1 + barReturnPct / 100));
      state.returns.push(barReturnPct);
      if (state.returns.length > 24) state.returns.shift();

      state.shock.remainingPct *= state.shock.decay;
      if (Math.abs(state.shock.remainingPct) < 0.05) state.shock.remainingPct = 0;

      const shockIntensity = Math.min(1, Math.abs(barReturnPct) / 3);
      const volumeBar =
        (state.avgVolume20d / BARS_PER_DAY) * (1 + shockIntensity * this.rng.range(1.2, 4.5));
      const volumeBarEma = state.volume24h / BARS_PER_DAY;
      const nextBarEma = volumeBarEma * 0.9 + volumeBar * 0.1;
      state.volume24h = Math.max(volumeBar, nextBarEma * BARS_PER_DAY);
      state.spreadPct = clamp(0.02 + shockIntensity * this.rng.range(0.05, 0.45), 0.005, 1.5);
      state.liquidations24h =
        state.liquidations24h * 0.6 + shockIntensity * this.rng.range(1_000_000, 10_000_000);
      state.openInterest = Math.max(
        1_000_000,
        state.openInterest * (1 + this.rng.range(-0.01, 0.012)),
      );
    }
  }

  snapshot(symbol: Symbol_): MarketSnapshot {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`No simulated state for ${symbol}`);

    const volatilityPct = this.volatility(state.returns);
    const window = state.returns.slice(-12);
    const changePct24h = window.reduce((acc, value) => acc + value, 0);
    const changePctBar = state.returns.at(-1) ?? 0;

    return {
      symbol,
      price: state.price,
      changePct24h,
      changePctBar,
      volume24h: state.volume24h,
      avgVolume20d: state.avgVolume20d,
      volatilityPct,
      spreadPct: state.spreadPct,
      openInterest: state.openInterest,
      liquidations24h: state.liquidations24h,
      timestamp: this.now(),
    };
  }

  private volatility(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = safeDivide(
      returns.reduce((acc, value) => acc + value, 0),
      returns.length,
    );
    const variance = safeDivide(
      returns.reduce((acc, value) => acc + (value - mean) ** 2, 0),
      returns.length - 1,
    );
    return Math.sqrt(variance);
  }
}
