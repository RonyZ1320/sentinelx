import { NewsEvent, Symbol_ } from '../types';

/**
 * Abstraction over news / event ingestion (Bitget announcements, RSS, X,
 * on-chain alerts). v0.1 ships a deterministic mock only.
 */
export interface EventFeed {
  readonly name: string;
  readonly isSimulated: boolean;
  /** Events observed since the last call, newest last. */
  poll(symbols: Symbol_[]): Promise<NewsEvent[]>;
}
