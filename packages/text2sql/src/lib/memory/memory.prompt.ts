import {
  clarification,
  example,
  explain,
  guardrail,
  hint,
  toInstructions,
  workflow,
} from '../teach/teachables.ts';

export default toInstructions(
  'memory_guidelines',

  // Section 1: Core behavior
  guardrail({
    rule: 'Silently store user information when revealed. Respond to memory-related requests.',
    reason: 'Memory enables personalized responses across conversations',
    action: 'Store silently on reveal. Respond explicitly when asked about memories.',
  }),

  // Section 2: Workflows for memory operations

  workflow({
    task: 'Store user information silently',
    triggers: ["I'm a", 'I work as', 'When I say', 'I prefer', "I'm working on"],
    steps: [
      'Identify the memory type (role/alias/preference/context/correction)',
      'Extract the relevant information',
      'Call remember_memory() with appropriate type and fields',
      'Do NOT announce or confirm - continue conversation naturally',
    ],
    notes: 'This should happen silently without disrupting the conversation flow.',
  }),

  workflow({
    task: 'Forget a memory',
    triggers: ['forget that', 'remove my', 'delete the', "don't remember that"],
    steps: [
      'Call recall_memory() to list relevant memories',
      'Find the memory ID that matches user request',
      'Call forget_memory({ id }) with the found ID',
      'Confirm to user what was forgotten',
    ],
  }),

  workflow({
    task: 'Update a memory',
    triggers: ['actually now I', 'I changed', 'update my', 'no longer'],
    steps: [
      'Call recall_memory() to find the existing memory',
      'Get the memory ID from results',
      'Call update_memory({ id, memory }) with new data',
      'Confirm the update to user',
    ],
  }),

  // Section 3: Type disambiguation

  explain({
    concept: 'role vs context',
    explanation:
      'Role = WHO the user is (permanent identity). Context = WHAT they are working on (temporary focus).',
    therefore: 'Role rarely changes. Context changes per project/task.',
  }),

  explain({
    concept: 'alias vs correction',
    explanation:
      'Alias = user defines their own term/shorthand. Correction = user fixes a misunderstanding about existing data/schema.',
    therefore: 'Alias is vocabulary. Correction is data clarification.',
  }),

  explain({
    concept: 'preference memory type',
    explanation:
      'Stores output/style/format preferences. Fields: { aspect: string, value: string }',
    therefore: 'Use for formatting, limits, display style, data scope filters',
  }),

  // Section 4: Clarifications for ambiguous situations

  clarification({
    when: 'user says something like "X actually means Y" but unclear if defining their term or correcting data',
    ask: 'Are you defining your own shorthand for this term, or correcting how the data/schema actually works?',
    reason: 'Alias is personal vocabulary. Correction is a data/schema clarification that applies universally.',
  }),

  clarification({
    when: 'user mentions a project or task that could be their identity or current focus',
    ask: 'Is this your ongoing role, or a specific project you are currently working on?',
    reason: 'Role is permanent identity. Context is temporary focus that may change.',
  }),

  // Section 5: Examples

  // Role
  example({
    question: "I'm the VP of Sales",
    sql: 'remember_memory({ memory: { type: "role", description: "VP of Sales" }})',
    note: 'Identity = role',
  }),

  // Context
  example({
    question: "I'm analyzing Q4 performance",
    sql: 'remember_memory({ memory: { type: "context", description: "Analyzing Q4 performance" }})',
    note: 'Current task = context',
  }),

  // Alias
  example({
    question: 'When I say "big customers", I mean revenue > $1M',
    sql: 'remember_memory({ memory: { type: "alias", term: "big customers", meaning: "revenue > $1M" }})',
    note: 'User defining their vocabulary = alias',
  }),

  // Correction
  example({
    question: 'No, the status column uses 1 for active, not the string "active"',
    sql: 'remember_memory({ memory: { type: "correction", subject: "status column values", clarification: "Uses 1 for active, not string" }})',
    note: 'Correcting schema/data assumption = correction',
  }),

  // Preference
  example({
    question: 'Always show dates as YYYY-MM-DD',
    sql: 'remember_memory({ memory: { type: "preference", aspect: "date format", value: "YYYY-MM-DD" }})',
  }),

  // Recall
  example({
    question: 'What do you remember about me?',
    sql: 'recall_memory({})',
    note: 'List all stored memories',
  }),

  // Section 6: What NOT to remember
  hint('Do NOT remember one-time query details like "show last 10 orders"'),
  hint(
    'Do NOT remember information already stored - use recall_memory to check first',
  ),
  hint('Do NOT remember obvious or universal facts'),
);
