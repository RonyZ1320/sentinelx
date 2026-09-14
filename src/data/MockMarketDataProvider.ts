import { MarketSnapshot, Symbol_ } from '../types';
import { SimulatedWorld } from './SimulatedWorld';
import { MarketDataProvider } from './MarketDataProvider';

/** Deterministic stand-in for a Bitget market data client. */
export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = 'mock-market';
  readonly isSimulated = true;

  constructor(
    private readonly world: SimulatedWorld,
    private readonly universe: string[],
  ) {}

  symbols(): Symbol_[] {
    return [...this.universe];
  }

  async getSnapshot(symbol: Symbol_): Promise<MarketSnapshot> {
    return this.world.snapshot(symbol);
  }

  async getSnapshots(symbols: Symbol_[]): Promise<MarketSnapshot[]> {
    return symbols.map((symbol) => this.world.snapshot(symbol));
  }

  async tick(): Promise<void> {
    this.world.tick();
  }
}
