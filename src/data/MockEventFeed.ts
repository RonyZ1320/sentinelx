import { NewsEvent, Symbol_ } from '../types';
import { SimulatedWorld } from './SimulatedWorld';
import { EventFeed } from './EventFeed';

/** Deterministic stand-in for a news / announcement feed. */
export class MockEventFeed implements EventFeed {
  readonly name = 'mock-events';
  readonly isSimulated = true;

  constructor(private readonly world: SimulatedWorld) {}

  async poll(symbols: Symbol_[]): Promise<NewsEvent[]> {
    const events = this.world.drainEvents();
    const wanted = new Set([...symbols, 'MARKET']);
    return events.filter((event) => wanted.has(event.symbol));
  }
}
