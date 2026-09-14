import { SentinelXSettings } from '../config/settings';
import { EventFeed } from './EventFeed';
import { MarketDataProvider } from './MarketDataProvider';
import { MockEventFeed } from './MockEventFeed';
import { MockMarketDataProvider } from './MockMarketDataProvider';
import { SimulatedWorld } from './SimulatedWorld';

/** Minimal clock contract the pipeline needs from the data layer. */
export interface SimClock {
  now(): number;
  barMinutes(): number;
}

export interface DataLayer {
  market: MarketDataProvider;
  events: EventFeed;
  world: SimClock;
}

/**
 * Single place to swap in real Bitget data later. Until then this always
 * returns the deterministic mock layer — no network access is performed.
 */
export function createDataLayer(settings: SentinelXSettings): DataLayer {
  const world = new SimulatedWorld(settings.symbols, settings.seed);
  return {
    world,
    market: new MockMarketDataProvider(world, settings.symbols),
    events: new MockEventFeed(world),
  };
}

export { SimulatedWorld } from './SimulatedWorld';
export type { MarketDataProvider } from './MarketDataProvider';
export type { EventFeed } from './EventFeed';
