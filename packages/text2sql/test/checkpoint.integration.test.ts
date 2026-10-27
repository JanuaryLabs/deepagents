import assert from 'node:assert';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import z from 'zod';

import { Checkpoint, jsonCodec } from '@deepagents/text2sql';

describe('Checkpoint — concurrent saves', () => {
  it('resumes every entry that a concurrent run stored before it stopped', async () => {
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'checkpoint-test-'),
    );
    const file = path.join(directory.path, 'checkpoint.json');
    const codec = jsonCodec(z.string());
    const inputs = Array.from({ length: 50 }, (_, i) => i);
    // A large first output makes every save of the run large, so a save that
    // started early can still be writing when a later one finishes.
    const outputOf = (input: number) =>
      `output ${input}`.repeat(input === 0 ? 200_000 : 1);

    const first = await Checkpoint.load({ path: file });
    const point = first.point('step', codec);
    await Promise.all(
      inputs.map((input) => point.through(input, async () => outputOf(input))),
    );

    const resumed = await Checkpoint.load({ path: file });
    const recomputed: number[] = [];
    const outputs = await Promise.all(
      inputs.map((input) =>
        resumed.point('step', codec).through(input, async () => {
          recomputed.push(input);
          return 'recomputed';
        }),
      ),
    );

    assert.deepStrictEqual(recomputed, []);
    assert.deepStrictEqual(outputs, inputs.map(outputOf));
  });
});
