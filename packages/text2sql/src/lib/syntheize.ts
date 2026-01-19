import { groq } from '@ai-sdk/groq';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

import postgres from './adapters/postgres/index.ts';
import { Checkpoint, hashConfig as hash } from './checkpoint.ts';
import {
  BreadthEvolver,
  DepthEvolver,
  type QuestionComplexity,
  SchemaSynthesizer,
  generatePersonas,
} from './synthesis/index.ts';
import { type ExtractedPair } from './synthesis/types.ts';

const CONFIG = {
  personaCount: 5,
  pairsPerComplexity: 4,
  depthEvolutionCount: 3,
  breadthEvolutionCount: 2,
  concurrency: 1,
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new postgres.Postgres({
  execute: async (sql) => pool.query(sql).then((it) => it.rows),
  grounding: [
    postgres.info(),
    postgres.tables(),
    postgres.constraints(),
    postgres.columnStats(),
    postgres.indexes(),
  ],
});

const checkpoint = await Checkpoint.load({
  path: 'output.json',
  configHash: hash(CONFIG),
});

console.log(`Estimated: `);
const estimate = estimateDatasetSize(CONFIG);
console.log(`- Seed pairs: ${estimate.seedPairs}`);
console.log(`- Depth pairs: ${estimate.evolvedPairs}`);
console.log(`- Breadth pairs: ${estimate.paraphrasedPairs}`);
console.log(`- Total pairs: ${estimate.total}\n`);

// const teachings = await checkpoint.run(
//   'teachings',
//   async () => {
//     console.log('Generating teachings...');
//     const generator = new TeachingsGenerator(adapter, {});
//     return generator.generate();
//   },
//   {
//     encode: (teachings: Teachables[]) => teachings.map((t) => t.encode()),
//     decode: (stored) => {
//       console.dir(stored, { depth: null });
//       return toTeachables(stored as never);
//     },
//   },
// );

const personas = await checkpoint.run('personas', async () => {
  console.log('Generating personas...');
  const schemaFragments = await adapter.introspect();
  return generatePersonas(schemaFragments, {
    count: CONFIG.personaCount,
  });
});

console.dir(checkpoint.getOutput(), { depth: null });

// Create input combinations for per-item checkpointing
const complexities: QuestionComplexity[] = [
  'simple',
  'moderate',
  'complex',
  'high complex',
];
const combinations = personas.flatMap((persona) =>
  complexities.map((complexity) => ({ persona, complexity })),
);

console.log('Generating seed pairs...');
const seed = (
  await checkpoint.each(
    'basePairs',
    combinations,
    async ({ persona, complexity }) => {
      console.log(
        `Generating pairs for persona: ${persona.role}, complexity: ${complexity}`,
      );
      const producer = new SchemaSynthesizer(adapter, {
        model: groq('openai/gpt-oss-20b'),
        count: CONFIG.pairsPerComplexity,
        complexity: [complexity],
        personas: [persona],
        teachings: [],
      });
      return producer.toPairs();
    },
    { concurrency: CONFIG.concurrency },
  )
).flat();
console.log(`✓ Seed pairs: ${seed.length}`);

console.log('Depth pairs...');
const evolvedPairs = (
  await checkpoint.each(
    'evolvedPairs',
    seed,
    async (pair) => {
      console.log('Depth pair:', pair.question);
      const producer = new DepthEvolver([pair], adapter, {
        count: CONFIG.depthEvolutionCount,
        model: groq('openai/gpt-oss-20b'),
      });
      return producer.toPairs();
    },
    { concurrency: CONFIG.concurrency },
  )
).flat();
console.log(`✓ Depth pairs: ${evolvedPairs.length}`);

console.log('Generating paraphrases...');
const paraphrasedPairs = (
  await checkpoint.each(
    'paraphrasedPairs',
    [...seed, ...evolvedPairs],
    async (pair) => {
      console.log(`Breadth pair:`, pair.question);
      const producer = new BreadthEvolver([pair], {
        count: CONFIG.breadthEvolutionCount,
      });
      return producer.toPairs();
    },
    { concurrency: CONFIG.concurrency },
  )
).flat();
console.log(`✓ Paraphrased pairs: ${paraphrasedPairs.length}`);

const allPairs = await checkpoint.run('allPairs', async () => {
  const all = [...seed, ...evolvedPairs, ...paraphrasedPairs];
  return all.filter((p) => p.success);
});

console.log(
  `\nTotal: ${allPairs.length} pairs saved to ${checkpoint.getPath()}`,
);

// Export training data in JSONL format for fine-tuning (two versions for A/B comparison)
// TODO: Update to use fragments and render them
// const schemaFragments = await adapter.introspect();
// const schema = new XmlRenderer().render(schemaFragments);
const schema = ''; // Placeholder - synthesis needs to be updated to use fragments

// Version 1: With schema context (recommended)
const withSchemaPath = 'training-with-schema.jsonl';
console.log(`\nExporting training data with schema to ${withSchemaPath}...`);
exportTrainingData(allPairs, schema, withSchemaPath);
console.log(`✓ Exported ${allPairs.length} pairs to ${withSchemaPath}`);

// Version 2: Without schema (for comparison)
const noSchemaPath = 'training-no-schema.jsonl';
console.log(`Exporting training data without schema to ${noSchemaPath}...`);
exportTrainingDataNoSchema(allPairs, noSchemaPath);
console.log(`✓ Exported ${allPairs.length} pairs to ${noSchemaPath}`);

interface SynthesisConfig {
  personaCount: number;
  pairsPerComplexity: number;
  depthEvolutionCount: number;
  breadthEvolutionCount: number;
  complexityLevels?: number;
}

function estimateDatasetSize(config: SynthesisConfig) {
  const complexityLevels = config.complexityLevels ?? 4;
  const seedPairs =
    config.personaCount * config.pairsPerComplexity * complexityLevels;
  const evolvedPairs = seedPairs * config.depthEvolutionCount;
  const totalBeforeParaphrase = seedPairs + evolvedPairs;
  const paraphrasedPairs = totalBeforeParaphrase * config.breadthEvolutionCount;
  const total = seedPairs + evolvedPairs + paraphrasedPairs;
  return { seedPairs, evolvedPairs, paraphrasedPairs, total };
}

/**
 * Export training pairs to JSONL format for SFTTrainer.
 * Uses chat messages format compatible with Qwen3 and other chat models.
 * Includes schema context in the prompt.
 */
function exportTrainingData(
  pairs: ExtractedPair[],
  schema: string,
  outputPath: string,
) {
  const lines = pairs
    .filter((p) => p.success)
    .map((p) =>
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: `Given the following SQL schema:\n${schema}\n\nWrite a SQL query to answer: ${p.question}`,
          },
          { role: 'assistant', content: p.sql },
        ],
      }),
    );

  writeFileSync(outputPath, lines.join('\n'));
}

/**
 * Export training pairs to JSONL format WITHOUT schema context.
 * For A/B comparison with schema-included version.
 */
function exportTrainingDataNoSchema(
  pairs: ExtractedPair[],
  outputPath: string,
) {
  const lines = pairs
    .filter((p) => p.success)
    .map((p) =>
      JSON.stringify({
        messages: [
          { role: 'user', content: p.question },
          { role: 'assistant', content: p.sql },
        ],
      }),
    );

  writeFileSync(outputPath, lines.join('\n'));
}
