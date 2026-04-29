import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillUploadInput } from '../../types.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface OpenAPISkillOptions {
  sandbox?: string;
}

export function openapiSkill(
  options: OpenAPISkillOptions = {},
): SkillUploadInput {
  return {
    host: here,
    sandbox: options.sandbox ?? '/skills/openapi',
  };
}
