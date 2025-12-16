/**
 * Natural language styles for text-to-SQL question generation.
 * Based on OmniSQL paper (March 2025): https://arxiv.org/html/2503.02240
 */

export type NLStyle =
  | 'formal' // Professional business language
  | 'colloquial' // Casual everyday speech
  | 'imperative' // Commands: "Show me...", "Get..."
  | 'interrogative' // Questions: "What is...", "How many..."
  | 'descriptive' // Verbose, detailed
  | 'concise' // Brief, minimal
  | 'vague' // Ambiguous, hedging
  | 'metaphorical' // Figurative language
  | 'conversational'; // Chat-like

export const styleInstructions: Record<NLStyle, string> = {
  formal: 'Use professional business language, complete sentences, no slang',
  colloquial: 'Use casual everyday speech, contractions, informal tone',
  imperative: 'Phrase as commands: "Show me...", "Get...", "List..."',
  interrogative: 'Phrase as questions: "What is...", "How many...", "Which..."',
  descriptive: 'Use detailed, verbose phrasing with extra context',
  concise: 'Use minimal words, telegram-style brevity',
  vague: 'Be intentionally ambiguous, use hedging language',
  metaphorical: 'Use figurative language, analogies, creative phrasing',
  conversational: 'Chat-like tone, as if talking to a colleague',
};

export const ALL_STYLES: NLStyle[] = [
  'formal',
  'colloquial',
  'imperative',
  'interrogative',
  'descriptive',
  'concise',
  'vague',
  'metaphorical',
  'conversational',
];
