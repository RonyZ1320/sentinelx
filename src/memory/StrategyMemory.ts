import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Lesson, MistakeTag, Symbol_ } from '../types';
import { SentinelXError, clamp, newId } from '../util';

interface MemoryFile {
  version: number;
  lessons: Lesson[];
}

const MAX_LESSON_IMPACT = 0.22;

/**
 * Long-term store of post-mortem lessons. The Thesis Engine, Adversary Agent
 * and Risk Engine all consult it so past mistakes actually change future
 * behaviour instead of being decoration.
 */
export class StrategyMemory {
  private readonly lessons = new Map<string, Lesson>();
  private readonly filePath: string;
  private loaded = false;

  constructor(storageDir: string, private readonly persist = true) {
    this.filePath = resolve(storageDir, 'memory.json');
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persist || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as MemoryFile;
      for (const lesson of parsed.lessons ?? []) {
        this.lessons.set(this.key(lesson.tag, lesson.symbol), lesson);
      }
    } catch (cause) {
      // A corrupt memory file must never stop the agent from running.
      process.stderr.write(
        `[sentinelx] strategy memory unreadable (${(cause as Error).message}); starting fresh\n`,
      );
    }
  }

  private key(tag: Lesson['tag'], symbol: Lesson['symbol']): string {
    return `${tag}::${symbol}`;
  }

  /** Insert or reinforce a lesson. Repeated lessons gain weight up to a cap. */
  remember(input: {
    tag: MistakeTag | 'POSITIVE_PATTERN';
    symbol: Symbol_ | 'ALL';
    weight: number;
    statement: string;
  }): Lesson {
    this.ensureLoaded();
    const now = Date.now();
    const key = this.key(input.tag, input.symbol);
    const existing = this.lessons.get(key);
    const lesson: Lesson = existing
      ? {
          ...existing,
          weight: clamp((existing.weight * existing.occurrences + input.weight) / (existing.occurrences + 1), -1, 1),
          statement: input.statement,
          occurrences: existing.occurrences + 1,
          lastSeenAt: now,
        }
      : {
          id: newId('lsn'),
          tag: input.tag,
          symbol: input.symbol,
          weight: clamp(input.weight, -1, 1),
          statement: input.statement,
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        };

    this.lessons.set(key, lesson);
    this.save();
    return lesson;
  }

  /**
   * Net confidence adjustment in [-MAX_LESSON_IMPACT, +MAX_LESSON_IMPACT] for
   * a candidate trade. `tags` are the mistake tags relevant to this setup.
   */
  adjustmentFor(symbol: Symbol_, tags: Array<MistakeTag | 'POSITIVE_PATTERN'> = []): number {
    this.ensureLoaded();
    let total = 0;
    for (const lesson of this.lessons.values()) {
      const appliesToSymbol = lesson.symbol === 'ALL' || lesson.symbol === symbol;
      if (!appliesToSymbol) continue;
      if (tags.length > 0 && lesson.tag !== 'POSITIVE_PATTERN' && !tags.includes(lesson.tag as MistakeTag)) {
        continue;
      }
      const frequencyBoost = 1 + Math.min(0.5, (lesson.occurrences - 1) * 0.1);
      total += lesson.weight * frequencyBoost;
    }
    return clamp(total * 0.35, -MAX_LESSON_IMPACT, MAX_LESSON_IMPACT);
  }

  relevantLessons(symbol: Symbol_, limit = 5): Lesson[] {
    this.ensureLoaded();
    return [...this.lessons.values()]
      .filter((lesson) => lesson.symbol === 'ALL' || lesson.symbol === symbol)
      .sort((a, b) => Math.abs(b.weight) * b.occurrences - Math.abs(a.weight) * a.occurrences)
      .slice(0, limit);
  }

  size(): number {
    this.ensureLoaded();
    return this.lessons.size;
  }

  private save(): void {
    if (!this.persist) return;
    const payload: MemoryFile = { version: 1, lessons: [...this.lessons.values()] };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (cause) {
      throw new SentinelXError(
        `Unable to persist strategy memory to ${this.filePath}: ${(cause as Error).message}`,
        'MEMORY_WRITE_FAILED',
      );
    }
  }
}
