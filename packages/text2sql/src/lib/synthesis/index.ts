// Core types and entry point
export { toPairs } from './types.ts';
export type { ExtractedPair, PairProducer } from './types.ts';

// Extractors (from data)
export { MessageExtractor, SqlExtractor } from './extractors/index.ts';
export type { MessageExtractorOptions, SqlExtractorOptions } from './extractors/index.ts';

// Synthesizers (from metadata)
export {
  SchemaSynthesizer,
  VariationSynthesizer,
} from './synthesizers/index.ts';
export type {
  SchemaSynthesizerOptions,
  VariationSynthesizerOptions,
} from './synthesizers/index.ts';

// Decorators (wrap other producers)
export {
  DeduplicatedProducer,
  FilteredProducer,
  ValidatedProducer,
} from './decorators/index.ts';
export type {
  DeduplicatedProducerOptions,
  FilteredProducerOptions,
  ValidatedPair,
  ValidatedProducerOptions,
} from './decorators/index.ts';
