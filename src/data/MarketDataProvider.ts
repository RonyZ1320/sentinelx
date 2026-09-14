import { MarketSnapshot, Symbol_ } from '../types';

/**
 * Abstraction over market data. A Bitget implementation can be dropped in
 * later without touching any agent: implement these methods and register the
 * provider in `createDataProvider()`.
 */
export interface MarketDataProvider {
  readonly name: string;
  /** True when this provider can only ever return simulated data. */
  readonly isSimulated: boolean;
  symbols(): Symbol_[];
  getSnapshot(symbol: Symbol_): Promise<MarketSnapshot>;
  getSnapshots(symbols: Symbol_[]): Promise<MarketSnapshot[]>;
  /** Advance simulated time / fetch the next batch. No-op for live providers. */
  tick(): Promise<void>;
}
