import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import pLimit from 'p-limit';
import z from 'zod';

export interface CheckpointOptions {
  /** Path to the checkpoint file */
  path: string;
  /** Hash to detect config changes - if changed, checkpoint is invalidated */
  configHash?: string;
}

/**
 * Codec for encoding/decoding values during checkpoint operations.
 * A checkpoint file is read back from disk, so decode() receives whatever
 * JSON holds there and must throw when it does not fit. Use {@link jsonCodec}
 * for plain JSON values; write a codec when storing objects with methods
 * (like Teachables) that need to be serialized to plain JSON and restored
 * with their methods.
 */
export interface Codec<T> {
  /** Convert runtime value to JSON-serializable format */
  encode: (value: T) => unknown;
  /** Convert stored JSON back to runtime value, throwing when it does not fit */
  decode: (stored: unknown) => T;
}

/**
 * Codec for values that are already plain JSON: stores them as they are and
 * validates them against the schema when they are read back.
 */
export function jsonCodec<T>(schema: z.ZodType<T>): Codec<T> {
  return { encode: (value) => value, decode: (stored) => schema.parse(stored) };
}

// The file shape save() writes.
const pointData = z.object({
  committed: z.boolean(),
  entries: z.array(
    z.object({ inputHash: z.string(), output: z.unknown().optional() }),
  ),
});

const checkpointFile = z.object({
  configHash: z.string().optional(),
  points: z.record(z.string(), pointData),
});

type PointData = z.infer<typeof pointData>;

type CheckpointFile = z.infer<typeof checkpointFile>;

export class Checkpoint {
  private points: Record<string, PointData>;
  private path: string;
  private configHash: string | undefined;

  private constructor(
    path: string,
    configHash: string | undefined,
    points: Record<string, PointData>,
  ) {
    this.points = points;
    this.path = path;
    this.configHash = configHash;
  }

  /**
   * Load checkpoint from file, or return empty checkpoint if none exists.
   * Handles corrupted files and config changes gracefully.
   */
  static async load(options: CheckpointOptions): Promise<Checkpoint> {
    const { path, configHash } = options;

    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        const file = checkpointFile.parse(JSON.parse(content));

        // Check if config changed
        if (configHash && file.configHash && file.configHash !== configHash) {
          console.log('⚠ Config changed, starting fresh');
          return new Checkpoint(path, configHash, {});
        }

        const points = file.points;
        const totalEntries = Object.values(points).reduce(
          (sum, p) => sum + p.entries.length,
          0,
        );
        console.log(`✓ Resuming from checkpoint (${totalEntries} entries)`);
        return new Checkpoint(path, configHash, points);
      } catch {
        console.log('⚠ Checkpoint corrupted, starting fresh');
        return new Checkpoint(path, configHash, {});
      }
    }

    console.log('Starting new checkpoint');
    return new Checkpoint(path, configHash, {});
  }

  /**
   * Run a single computation with checkpointing.
   * If already completed, returns cached value.
   *
   * @param key - Unique identifier for this computation
   * @param computation - Async function that produces the value
   * @param codec - Codec that stores the value and restores it on resume
   */
  async run<T>(
    key: string,
    computation: () => Promise<T>,
    codec: Codec<T>,
  ): Promise<T> {
    // Use fixed input hash for single-value runs
    return this.point(key, codec).through('single', computation);
  }

  /**
   * Create a resumable checkpoint point for iterative operations.
   *
   * @param step - Unique identifier for this checkpoint point
   * @param codec - Codec that stores each output and restores it on resume
   */
  point<T>(step: string, codec: Codec<T>): Point<T> {
    this.points[step] ??= { committed: false, entries: [] };
    return new Point(this.points[step], codec, () => this.save());
  }

  /**
   * Process each input with automatic checkpointing and concurrency.
   *
   * @param step - Unique identifier for this checkpoint
   * @param inputs - Items to process
   * @param process - Function to process each input
   * @param codec - Codec that stores each output and restores it on resume
   * @param options - Optional settings like concurrency
   * @returns All outputs (use `.flat()` if outputs are arrays)
   */
  async each<I, O>(
    step: string,
    inputs: Iterable<I>,
    process: (input: I) => Promise<O>,
    codec: Codec<O>,
    options?: { concurrency?: number },
  ): Promise<O[]> {
    const point = this.point(step, codec);
    const limit = pLimit(options?.concurrency ?? 1);

    const inputArray = Array.from(inputs);
    await Promise.all(
      inputArray.map((input) =>
        limit(() => point.through(input, () => process(input))),
      ),
    );

    await point.commit();
    return point.values();
  }

  /**
   * Get clean output from all completed points.
   * Single-entry points return the value directly, multi-entry return arrays.
   */
  getOutput(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, pointData] of Object.entries(this.points)) {
      if (pointData.entries.length === 1) {
        output[key] = pointData.entries[0].output;
      } else {
        output[key] = pointData.entries.map((e) => e.output);
      }
    }
    return output;
  }

  /** Get the file path where checkpoint is stored */
  getPath(): string {
    return this.path;
  }

  private async save(): Promise<void> {
    const file: CheckpointFile = {
      configHash: this.configHash,
      points: this.points,
    };
    const content = JSON.stringify(file, null, 2);

    // Atomic write: write to temp file, then rename
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, this.path);
  }
}

function hash(value: unknown): string {
  return createHash('md5').update(JSON.stringify(value)).digest('hex');
}

/**
 * A checkpoint point for tracking iterative operations.
 * Uses input hashing to determine if an operation was already processed.
 */
export class Point<T> {
  #stored: Map<string, unknown>;
  private data: PointData;
  private codec: Codec<T>;
  private persist: () => Promise<void>;

  constructor(data: PointData, codec: Codec<T>, persist: () => Promise<void>) {
    this.#stored = new Map(data.entries.map((e) => [e.inputHash, e.output]));
    this.data = data;
    this.codec = codec;
    this.persist = persist;
  }

  /**
   * Execute computation if input wasn't processed before.
   * Returns the decoded stored output if input hash exists, otherwise
   * executes, saves the encoded output, and returns the computed value.
   */
  async through(input: unknown, compute: () => Promise<T>): Promise<T> {
    const inputHash = hash(input);

    if (this.#stored.has(inputHash)) {
      return this.codec.decode(this.#stored.get(inputHash));
    }

    const value = await compute();
    const output = this.codec.encode(value);
    this.data.entries.push({ inputHash, output });
    this.#stored.set(inputHash, output);
    await this.persist();
    return value;
  }

  /** Mark this point as complete. */
  async commit(): Promise<void> {
    this.data.committed = true;
    await this.persist();
  }

  /** Check if this point has been committed. */
  isCommitted(): boolean {
    return this.data.committed;
  }

  /** Get all outputs from this point. */
  values(): T[] {
    return this.data.entries.map((e) => this.codec.decode(e.output));
  }
}

/**
 * Generate a hash from a config object for checkpoint invalidation.
 * If config changes, the checkpoint will be invalidated and pipeline restarts.
 */
export function hashConfig(config: Record<string, unknown>): string {
  return createHash('md5').update(JSON.stringify(config)).digest('hex');
}
