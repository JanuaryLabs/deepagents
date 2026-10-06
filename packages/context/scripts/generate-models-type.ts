import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The part of https://models.dev/api.json this script reads: provider id → model id. */
const modelsDevResponse = z.record(
  z.string(),
  z.object({ models: z.record(z.string(), z.unknown()) }),
);

async function main() {
  console.log('Fetching models from models.dev...');
  const response = await fetch('https://models.dev/api.json');
  const data = modelsDevResponse.parse(await response.json());

  const modelIds: string[] = [];

  for (const [providerId, provider] of Object.entries(data)) {
    for (const modelId of Object.keys(provider.models)) {
      modelIds.push(`${providerId}:${modelId}`);
    }
  }

  modelIds.sort();

  const typeContent = `// Auto-generated from models.dev - do not edit
// Generated on ${new Date().toISOString()}
// Total models: ${modelIds.length}

export type KnownModels =
${modelIds.map((id) => `  | '${id}'`).join('\n')};

// Allows custom provider:model while providing autocomplete for known models
export type Models = KnownModels | (string & {});
`;

  const outputPath = join(__dirname, '../src/lib/models.generated.ts');
  writeFileSync(outputPath, typeContent);

  console.log(`Generated ${modelIds.length} model IDs`);
  console.log(`Output: ${outputPath}`);
}

main().catch(console.error);
