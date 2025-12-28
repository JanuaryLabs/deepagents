import {
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  assistant,
  hint,
  role,
  user,
} from './index.ts';

// Create a shared store for persistence
const store = new InMemoryContextStore();

/**
 * Example: Using ContextEngine with messages and chatId
 *
 * This demonstrates the API flow:
 * 1. Create context with store and chatId
 * 2. Set up context with role and hints
 * 3. Add user message
 * 4. Resolve to get systemPrompt and messages for AI SDK
 * 5. Add assistant response
 * 6. Save to store
 */
async function demonstrateContextEngine() {
  console.log('=== Basic Context Engine Example ===');

  // Create context with store and chatId (REQUIRED)
  const context = new ContextEngine({
    store,
    chatId: 'demo-chat-1',
  }).set(
    role('You are a helpful assistant.'),
    hint('Be concise and friendly.'),
    hint('Use examples when explaining concepts.'),
  );

  // First turn: User sends a message
  context.set(user('Hello! What can you help me with?'));

  // Resolve context for AI SDK
  const { systemPrompt, messages } = await context.resolve({
    renderer: new XmlRenderer(),
  });

  console.log('System Prompt:\n', systemPrompt);
  console.log('Messages:', messages);

  // Simulate AI response (in real usage, this comes from AI SDK generate())
  context.set(
    assistant('Hi! I can help you with coding, writing, analysis, and more.'),
  );

  // Save after AI responds (explicit - developer decides when)
  await context.save();

  // Second turn: User sends another message
  context.set(user('Tell me a joke.'));

  // Resolve again - now includes previous conversation
  const result2 = await context.resolve();
  console.log('\nSecond turn messages:', result2.messages.length);

  // Estimate cost
  const estimate = await context.estimate(
    'groq:moonshotai/kimi-k2-instruct-0905',
  );
  console.log('Estimated tokens:', estimate.tokens);
  console.log('Estimated cost: $', estimate.cost.toFixed(6));
}

/**
 * Example: Session restore with chatId
 *
 * Loading a previously saved chat by its ID.
 */
async function demonstrateSessionRestore() {
  console.log('\n=== Session Restore ===');

  // New context instance, same store, same chatId - will load persisted messages
  const context = new ContextEngine({
    store,
    chatId: 'demo-chat-1', // Same ID as previous example
  }).set(role('You are a helpful assistant.'));

  // Resolve loads persisted messages from store
  const { messages } = await context.resolve();

  console.log('Restored messages from previous session:', messages.length);
}

/**
 * Example: Multiple independent chats
 *
 * Same store can hold multiple chats, each with their own ID.
 */
async function demonstrateMultipleChats() {
  console.log('\n=== Multiple Chats ===');

  // Chat A
  const contextA = new ContextEngine({
    store,
    chatId: 'chat-a',
  });
  contextA.set(user('Question for chat A'));
  await contextA.save();

  // Chat B (same store, different ID)
  const contextB = new ContextEngine({
    store,
    chatId: 'chat-b',
  });
  contextB.set(user('Question for chat B'));
  await contextB.save();

  // List all chats
  const chats = await store.listChats();
  console.log('Total chats:', chats.length);
  for (const chat of chats) {
    console.log(
      `  - ${chat.id}: ${chat.messageCount} messages, ${chat.branchCount} branches`,
    );
  }
}

/**
 * Example: Chat metadata
 *
 * Adding title and custom metadata to a chat.
 */
async function demonstrateChatMetadata() {
  console.log('\n=== Chat Metadata ===');

  const context = new ContextEngine({
    store,
    chatId: 'titled-chat',
  });

  // Add some messages
  context.set(user('Help me learn Python'));
  context.set(assistant('Great choice! Python is beginner-friendly.'));
  await context.save();

  // Update chat with title and metadata
  await context.updateChat({
    title: 'Python Learning Session',
    metadata: { tags: ['python', 'learning'], priority: 'high' },
  });

  console.log('Chat ID:', context.chatId);
  console.log('Chat meta:', context.chat);
}

/**
 * Example: Rewind creates a new branch
 *
 * This demonstrates the graph-based rewind:
 * 1. Create messages with custom IDs
 * 2. Rewind to remove a bad response (creates new branch)
 * 3. Original branch is preserved
 * 4. Can switch between branches
 */
async function demonstrateRewind() {
  console.log('\n=== Rewind Example (Branch-Creating) ===');

  const rewindStore = new InMemoryContextStore();
  const context = new ContextEngine({
    store: rewindStore,
    chatId: 'rewind-demo',
  }).set(role('You are a helpful assistant.'));

  // Add a question with a custom ID for easy targeting
  context.set(user('What is 2 + 2?', { id: 'math-question' }));
  context.set(assistant('The answer is 5.', { id: 'wrong-answer' })); // Oops!
  await context.save();

  const before = await context.resolve();
  console.log('Before rewind - messages:', before.messages.length);
  console.log('Current branch:', context.branch);

  // Rewind to keep the question but remove the wrong answer
  // This creates a NEW BRANCH - original is preserved
  const newBranch = await context.rewind('math-question');
  console.log('Created new branch:', newBranch.name);

  const after = await context.resolve();
  console.log('After rewind - messages:', after.messages.length);
  console.log('Kept message:', after.messages[0]);

  // Now add the correct answer on the new branch
  context.set(assistant('The answer is 4.', { id: 'correct-answer' }));
  await context.save();

  const final = await context.resolve();
  console.log('Final messages on new branch:', final.messages);

  // List all branches - both should exist (via store)
  const branches = await rewindStore.listBranches(context.chatId);
  console.log('\nAll branches:');
  for (const branch of branches) {
    console.log(
      `  - ${branch.name}: ${branch.messageCount} messages, active: ${branch.isActive}`,
    );
  }

  // Can switch back to original branch
  await context.switchBranch('main');
  const originalMessages = await context.resolve();
  console.log(
    '\nOriginal branch still has:',
    originalMessages.messages.length,
    'messages',
  );
  console.log(
    'Original last message:',
    originalMessages.messages.at(-1)?.content,
  );
}

/**
 * Example: Conversation branching with checkpoints
 *
 * This demonstrates checkpoint and restore:
 * 1. Create a checkpoint before a decision point
 * 2. Explore one conversation branch
 * 3. Restore and explore a different branch
 */
async function demonstrateBranching() {
  console.log('\n=== Branching Example ===');

  const branchStore = new InMemoryContextStore();
  const context = new ContextEngine({
    store: branchStore,
    chatId: 'branch-demo',
  }).set(role('You are a helpful assistant.'));

  // Initial conversation
  context.set(user('I want to learn a new skill.'));
  context.set(assistant('Great! Would you like to learn coding or cooking?'));
  await context.save();

  // Save checkpoint before the user's choice
  const beforeChoice = await context.checkpoint('before-choice');
  console.log('Created checkpoint:', beforeChoice.name);

  // Branch A: User chooses coding
  context.set(user('I want to learn coding.'));
  context.set(assistant('Python is a great starting language!'));
  await context.save();

  const branchA = await context.resolve();
  console.log('Branch A messages:', branchA.messages.length);

  // Restore to before the choice (creates new branch)
  const restoredBranch = await context.restore('before-choice');
  console.log('Restored to checkpoint, new branch:', restoredBranch.name);

  // Branch B: User chooses cooking
  context.set(user('I want to learn cooking.'));
  context.set(assistant('Italian cuisine is a great place to start!'));
  await context.save();

  const branchB = await context.resolve();
  console.log('Branch B messages:', branchB.messages.length);
  console.log('Last message in Branch B:', branchB.messages.at(-1)?.content);

  // List all branches (via store)
  const branches = await branchStore.listBranches(context.chatId);
  console.log('\nAll branches after branching:');
  for (const branch of branches) {
    console.log(`  - ${branch.name}: ${branch.messageCount} messages`);
  }

  // List checkpoints (via store)
  const checkpoints = await branchStore.listCheckpoints(context.chatId);
  console.log('\nCheckpoints:');
  for (const cp of checkpoints) {
    console.log(`  - ${cp.name} -> message ${cp.messageId}`);
  }
}

/**
 * Example: Branch switching
 *
 * Switch between different conversation branches.
 */
async function demonstrateBranchSwitching() {
  console.log('\n=== Branch Switching ===');

  const switchStore = new InMemoryContextStore();
  const context = new ContextEngine({
    store: switchStore,
    chatId: 'switch-demo',
  });

  // Use explicit message IDs for easy rewind
  context.set(user('Question 1', { id: 'q1' }));
  context.set(assistant('Answer 1', { id: 'a1' }));
  await context.save();

  console.log('On main branch:', context.branch);

  // Create alternative from q1 (creates new branch)
  await context.rewind('q1');
  console.log('Switched to:', context.branch);

  context.set(assistant('Alternative answer 1', { id: 'alt-a1' }));
  await context.save();

  // Switch back to main
  await context.switchBranch('main');
  console.log('Switched back to:', context.branch);

  const mainMessages = await context.resolve();
  console.log(
    'Main branch messages:',
    mainMessages.messages.map((m) => m.content),
  );

  // Switch to alternative
  await context.switchBranch('main-v2');
  const altMessages = await context.resolve();
  console.log(
    'Alt branch messages:',
    altMessages.messages.map((m) => m.content),
  );
}

// Run examples
async function main() {
  await demonstrateContextEngine();
  await demonstrateSessionRestore();
  await demonstrateMultipleChats();
  await demonstrateChatMetadata();
  await demonstrateRewind();
  await demonstrateBranching();
  await demonstrateBranchSwitching();
}

main().catch(console.error);
