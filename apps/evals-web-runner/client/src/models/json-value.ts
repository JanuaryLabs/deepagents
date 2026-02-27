import type * as models from '../index.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | models.JsonObject
  | models.JsonValue[];
