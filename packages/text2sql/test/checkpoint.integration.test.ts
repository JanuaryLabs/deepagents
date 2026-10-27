import assert from 'node:assert';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import z from 'zod';

import { Checkpoint, jsonCodec } from '@deepagents/text2sql';

describe('Checkpoint — concurrent saves', () => {
  it('resumes every entry that a concurrent run stored before it stopped', async () => {
    await using directory = await mkdtempDisposable(
      path.join(tmpdir(), 'checkpoint-test-'),
    );
    const codec = jsonCodec(z.string());
    const inputs = Array.from({ length: 200 }, (_, i) => i);
    // A large first output makes every save of the run large, so a save that
    // started early can still be writing when a later one finishes.
    const outputOf = (input: number) =>
      `output ${input}`.repeat(input === 0 ? 20_000 : 1);

    // Writes that run at the same time finish out of order only some of the
    // time, so the run repeats, each time on a new file.
    for (let run = 0; run < 5; run += 1) {
      const file = path.join(directory.path, `checkpoint-${run}.json`);
      const first = await Checkpoint.load({ path: file });
      const point = first.point('step', codec);
      await Promise.all(
        inputs.map((input) =>
          point.through(input, async () => {
            // The outputs arrive over several turns of the event loop, so new
            // entries come in while an earlier save still writes.
            for (let turn = 0; turn < input % 7; turn += 1)
              await setImmediate();
            return outputOf(input);
          }),
        ),
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

      assert.deepStrictEqual(recomputed, [], `run ${run}`);
      assert.deepStrictEqual(outputs, inputs.map(outputOf), `run ${run}`);
    }
  });
});
