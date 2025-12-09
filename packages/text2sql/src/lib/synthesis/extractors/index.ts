export { MessageExtractor } from './message-extractor.ts';
export type { MessageExtractorOptions } from './message-extractor.ts';

export { SqlExtractor } from './sql-extractor.ts';
export type { SqlExtractorOptions } from './sql-extractor.ts';

// New Template Pattern based extractors
export { BaseContextualExtractor } from './base-contextual-extractor.ts';
export type {
  BaseContextualExtractorOptions,
  DbQueryInput,
  SqlWithContext,
} from './base-contextual-extractor.ts';
export {
  contextResolverAgent,
  formatConversation,
  getMessageText,
} from './base-contextual-extractor.ts';

export { FullContextExtractor } from './full-context-extractor.ts';
export type { FullContextExtractorOptions } from './full-context-extractor.ts';

export { WindowedContextExtractor } from './windowed-context-extractor.ts';
export type { WindowedContextExtractorOptions } from './windowed-context-extractor.ts';

export { SegmentedContextExtractor } from './segmented-context-extractor.ts';
export type { SegmentedContextExtractorOptions } from './segmented-context-extractor.ts';
