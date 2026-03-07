import type { SessionEvent, StreamConfig } from "../events/types.js";
import type { SessionEventFilter } from "../events/emitter.js";
import { SessionEventEmitter } from "../events/emitter.js";

// ─── RingBuffer ──────────────────────────────────────────────────────────────

/**
 * Fixed-capacity ring buffer for SessionEvent objects.
 * When the buffer is full, the oldest event is overwritten.
 */
class RingBuffer {
  private buffer: (SessionEvent | undefined)[];
  private head: number = 0; // next write position
  private count: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("RingBuffer capacity must be ≥ 1");
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(undefined);
  }

  /** Push an event. Overwrites the oldest entry when full. */
  push(event: SessionEvent): void {
    this.buffer[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Number of events currently stored in the buffer. */
  get size(): number {
    return this.count;
  }

  /**
   * Return all stored events in order (oldest first).
   */
  toArray(): SessionEvent[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      // Buffer hasn't wrapped yet — events live at [0..count-1]
      return this.buffer.slice(0, this.count) as SessionEvent[];
    }
    // Buffer is full and has wrapped — oldest entry is at `head`
    const result: SessionEvent[] = [];
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.buffer[idx] as SessionEvent);
    }
    return result;
  }

  /** Clear the buffer. */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

// ─── SessionFeedSubscriber ───────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 100;

/**
 * Subscribes to a SessionEventEmitter, maintains a fixed-size ring buffer of
 * received events, and supports replay from a logical offset.
 */
export class SessionFeedSubscriber {
  private emitter: SessionEventEmitter;
  private buffer: RingBuffer;
  private config: Required<Pick<StreamConfig, "bufferSize" | "replayFromOffset">> & Partial<StreamConfig>;
  private unsubscribeFn: (() => void) | null = null;
  private eventHandlers: Set<(event: SessionEvent) => void> = new Set();
  private offset: number = 0; // total events received (ever)

  constructor(emitter: SessionEventEmitter, config?: Partial<StreamConfig>) {
    this.emitter = emitter;
    this.config = {
      bufferSize: config?.bufferSize ?? DEFAULT_BUFFER_SIZE,
      replayFromOffset: config?.replayFromOffset ?? 0,
      filterTypes: config?.filterTypes,
      maxAge: config?.maxAge,
    };
    this.buffer = new RingBuffer(this.config.bufferSize);
  }

  /**
   * Connect to the emitter and start receiving events.
   * @param config  Optional StreamConfig override (merged with constructor config).
   */
  subscribe(config?: Partial<StreamConfig>): void {
    if (this.unsubscribeFn) {
      // Already subscribed — re-subscribe is a no-op (idempotent)
      return;
    }

    if (config) {
      this.config = {
        ...this.config,
        ...config,
      };
      // Re-create buffer if bufferSize changed
      if (config.bufferSize !== undefined && config.bufferSize !== this.buffer.capacity) {
        const existing = this.buffer.toArray();
        this.buffer = new RingBuffer(config.bufferSize);
        for (const ev of existing) {
          this.buffer.push(ev);
        }
      }
    }

    const filter: SessionEventFilter | undefined =
      this.config.filterTypes && this.config.filterTypes.length > 0
        ? (this.config.filterTypes as import("../events/types.js").EventType[])
        : undefined;

    this.unsubscribeFn = this.emitter.subscribe((event: SessionEvent) => {
      this.buffer.push(event);
      this.offset++;
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch {
          // Swallow handler errors
        }
      }
    }, filter);
  }

  /**
   * Disconnect from the emitter. The buffer is retained so replay still works.
   */
  unsubscribe(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
  }

  /**
   * Returns a copy of all events currently in the ring buffer (oldest first).
   */
  getBuffer(): SessionEvent[] {
    return this.buffer.toArray();
  }

  /**
   * Return events from `offset` to the current head of the buffer.
   *
   * The offset is a logical sequence number: 0 = first event ever received.
   * Because the ring buffer may have discarded old events, this method returns
   * what is still available starting at (or after) `offset`.
   *
   * @param offset  Logical offset (0-based) to replay from.
   */
  replayFrom(offset: number): SessionEvent[] {
    const all = this.buffer.toArray();
    // `this.offset` is the total events received; the ring buffer holds the last
    // `bufferSize` of those.
    const bufferStartOffset = Math.max(0, this.offset - all.length);

    if (offset >= this.offset) {
      // Requested offset is beyond the current head — nothing to replay
      return [];
    }

    if (offset <= bufferStartOffset) {
      // Requested offset is before the buffer start — return the whole buffer
      return all;
    }

    // Slice from within the buffer
    const sliceStart = offset - bufferStartOffset;
    return all.slice(sliceStart);
  }

  /**
   * Register a handler that fires for every incoming event.
   * @returns  A function that removes this handler.
   */
  onEvent(handler: (event: SessionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Returns the total number of events received since subscribe() was called.
   * Acts as a logical write pointer / sequence cursor.
   */
  getOffset(): number {
    return this.offset;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Convenience factory: create a subscriber and call subscribe() in one step.
 */
export function createSessionFeedSubscriber(
  emitter: SessionEventEmitter,
  config?: Partial<StreamConfig>
): SessionFeedSubscriber {
  const subscriber = new SessionFeedSubscriber(emitter, config);
  subscriber.subscribe();
  return subscriber;
}
