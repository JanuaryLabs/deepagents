import { groq } from '@ai-sdk/groq';
import { createBashTool } from 'bash-tool';
import chalk from 'chalk';
import { Bash, OverlayFs } from 'just-bash';

import { printer } from '@deepagents/agent';

import {
  type ContextFragment,
  InMemoryContextStore,
  XmlRenderer,
  assistantText,
  // Docker sandbox
  createContainerTool,
  createDockerSandbox,
  hint,
  role,
  // Skills fragment
  skills,
  user,
  visualizeGraph,
} from './index.ts';
import { agent } from './lib/agent.ts';
import { ContextEngine } from './lib/engine.ts';

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

  const context = new ContextEngine({
    userId: 'demo-user',
    store: new InMemoryContextStore(),
    chatId: 'chat-1',
  });

  context.set(
    role('You are a helpful assistant.'),
    hint('Be concise and friendly.'),
    hint('Use examples when explaining concepts.'),
  );

  context.set(user('Hello! What can you help me with?'));

  const { systemPrompt, messages } = await context.resolve({
    renderer: new XmlRenderer(),
  });

  console.log('System Prompt:\n', systemPrompt);
  console.log('Messages:', messages);

  // Simulate AI response (in real usage, this comes from AI SDK generate())
  context.set(
    assistantText(
      'Hi! I can help you with coding, writing, analysis, and more.',
    ),
  );

  // Save after AI responds (explicit - developer decides when)
  await context.save();

  // Second turn: User sends another message
  context.set(user('Tell me a joke.'));

  // Resolve again - now includes previous conversation
  const result2 = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('\nSecond turn messages:', result2.messages.length);

  // Estimate cost
  // const estimate = await context.estimate(
  //   'groq:moonshotai/kimi-k2-instruct-0905',
  // );
  const inspection = await context.inspect({
    modelId: 'groq:moonshotai/kimi-k2-instruct-0905',
    renderer: new XmlRenderer(),
  });
  console.log(JSON.stringify(inspection, null, 2));

  // Visualize the message graph
  const graph = await store.getGraph('demo-chat-1');
  console.log('\nMessage Graph:');
  console.log(visualizeGraph(graph));
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
    userId: 'demo-user',
    store,
    chatId: 'demo-chat-1', // Same ID as previous example
  }).set(role('You are a helpful assistant.'));

  // Resolve loads persisted messages from store
  const { messages } = await context.resolve({
    renderer: new XmlRenderer(),
  });

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
    userId: 'demo-user',
    store,
    chatId: 'chat-a',
  });
  contextA.set(user('Question for chat A'));
  await contextA.save();

  // Chat B (same store, different ID)
  const contextB = new ContextEngine({
    userId: 'demo-user',
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
    userId: 'demo-user',
    store,
    chatId: 'titled-chat',
  });

  // Add some messages
  context.set(user('Help me learn Python'));
  context.set(assistantText('Great choice! Python is beginner-friendly.'));
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
    userId: 'demo-user',
    store: rewindStore,
    chatId: 'rewind-demo',
  }).set(role('You are a helpful assistant.'));

  // Add a question with a custom ID for easy targeting
  context.set(user('What is 2 + 2?'));
  context.set(assistantText('The answer is 5.', { id: 'wrong-answer' })); // Oops!
  await context.save();

  const before = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('Before rewind - messages:', before.messages.length);
  console.log('Current branch:', context.branch);

  // Rewind to keep the question but remove the wrong answer
  // This creates a NEW BRANCH - original is preserved
  const newBranch = await context.rewind('math-question');
  console.log('Created new branch:', newBranch.name);

  const after = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('After rewind - messages:', after.messages.length);
  console.log('Kept message:', after.messages[0]);

  // Now add the correct answer on the new branch
  context.set(assistantText('The answer is 4.', { id: 'correct-answer' }));
  await context.save();

  const final = await context.resolve({
    renderer: new XmlRenderer(),
  });
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
  const originalMessages = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log(
    '\nOriginal branch still has:',
    originalMessages.messages.length,
    'messages',
  );
  console.log('Original last message:', originalMessages.messages.length);
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
    userId: 'demo-user',
    store: branchStore,
    chatId: 'branch-demo',
  }).set(role('You are a helpful assistant.'));

  // Initial conversation
  context.set(user('I want to learn a new skill.'));
  context.set(
    assistantText('Great! Would you like to learn coding or cooking?'),
  );
  await context.save();

  // Save checkpoint before the user's choice
  const beforeChoice = await context.checkpoint('before-choice');
  console.log('Created checkpoint:', beforeChoice.name);

  // Branch A: User chooses coding
  context.set(user('I want to learn coding.'));
  context.set(assistantText('Python is a great starting language!'));
  await context.save();

  const branchA = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('Branch A messages:', branchA.messages.length);

  // Restore to before the choice (creates new branch)
  const restoredBranch = await context.restore('before-choice');
  console.log('Restored to checkpoint, new branch:', restoredBranch.name);

  // Branch B: User chooses cooking
  context.set(user('I want to learn cooking.'));
  context.set(assistantText('Italian cuisine is a great place to start!'));
  await context.save();

  const branchB = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('Branch B messages:', branchB.messages.length);
  console.log('Last message in Branch B:', branchB.messages.at(-1));

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
    userId: 'demo-user',
    store: switchStore,
    chatId: 'switch-demo',
  });

  // Use explicit message IDs for easy rewind
  context.set(user('Question 1'));
  context.set(assistantText('Answer 1', { id: 'a1' }));
  await context.save();

  console.log('On main branch:', context.branch);

  // Create alternative from q1 (creates new branch)
  await context.rewind('q1');
  console.log('Switched to:', context.branch);

  context.set(assistantText('Alternative answer 1', { id: 'alt-a1' }));
  await context.save();

  // Switch back to main
  await context.switchBranch('main');
  console.log('Switched back to:', context.branch);

  const mainMessages = await context.resolve({ renderer: new XmlRenderer() });
  console.log('Main branch messages:', mainMessages.messages);

  // Switch to alternative
  await context.switchBranch('main-v2');
  const altMessages = await context.resolve({
    renderer: new XmlRenderer(),
  });
  console.log('Alt branch messages:', altMessages.messages);
}

/**
 * Example: Graph Visualization
 *
 * Visualize the message graph structure with branches and checkpoints.
 */
async function demonstrateVisualization() {
  console.log('\n=== Graph Visualization ===');

  const vizStore = new InMemoryContextStore();
  const context = new ContextEngine({
    userId: 'demo-user',
    store: vizStore,
    chatId: 'viz-demo',
  });

  // Create a conversation with branching
  context.set(user('Hello'));
  context.set(assistantText('Hi there!', { id: 'msg-2' }));
  await context.save();

  // Create a checkpoint
  await context.checkpoint('greeting-done');

  // Continue conversation
  context.set(user('Help with Python'));
  context.set(assistantText('Sure, I can help!', { id: 'msg-4' }));
  await context.save();

  // Rewind and create alternative branch
  await context.rewind('msg-2');
  context.set(user('Help with JavaScript'));
  context.set(assistantText('JavaScript is great!'));
  await context.save();

  // Get and visualize the graph
  const graph = await vizStore.getGraph('viz-demo');
  console.log('\nGraph structure:');
  console.log(visualizeGraph(graph));
}

/**
 * Example: Full-Text Search
 *
 * Search messages using FTS5 with stemming, ranking, and snippets.
 */
async function demonstrateSearch() {
  console.log('\n=== Full-Text Search ===');

  const searchStore = new InMemoryContextStore();
  const context = new ContextEngine({
    userId: 'demo-user',
    store: searchStore,
    chatId: 'search-demo',
  });

  // Add some messages to search through
  context.set(user('How do I learn Python programming?'));
  context.set(
    assistantText(
      'Python is a great language for beginners. Start with basic syntax and data types.',
    ),
  );
  await context.save();

  context.set(user('What about JavaScript?'));
  context.set(
    assistantText(
      'JavaScript is essential for web development. Learn DOM manipulation and async programming.',
    ),
  );
  await context.save();

  context.set(user('Can you recommend some machine learning resources?'));
  context.set(
    assistantText(
      'For machine learning, start with Python libraries like scikit-learn and TensorFlow.',
    ),
  );
  await context.save();

  // Basic search - finds "Python", "python", "pythons" (stemming)
  console.log('\nSearch for "python":');
  const pythonResults = await searchStore.searchMessages(
    'search-demo',
    'python',
  );
  for (const result of pythonResults) {
    console.log(`  [rank: ${result.rank.toFixed(2)}] ${result.snippet}`);
  }

  // Search with FTS5 syntax
  console.log('\nSearch for "learn AND programming":');
  const learnResults = await searchStore.searchMessages(
    'search-demo',
    'learn AND programming',
  );
  for (const result of learnResults) {
    console.log(`  [rank: ${result.rank.toFixed(2)}] ${result.snippet}`);
  }

  // Search only user messages
  console.log('\nSearch user messages only for "learn":');
  const userResults = await searchStore.searchMessages('search-demo', 'learn', {
    roles: ['user'],
  });
  for (const result of userResults) {
    console.log(
      `  [${result.message.name}] [rank: ${result.rank.toFixed(2)}] ${result.snippet}`,
    );
  }
}

/**
 * Example: Skills System (Anthropic-style progressive disclosure)
 *
 * Demonstrates how to use the skills system:
 * 1. Create a registry with skill directories
 * 2. Discover skills (loads metadata only - name + description)
 * 3. Add skills fragment to context (metadata injected into system prompt)
 * 4. LLM reads full SKILL.md content when relevant using file tools
 */
async function demonstrateSkills() {
  // Create context with skills metadata injected into system prompt
  const skillStore = new InMemoryContextStore();
  const context = new ContextEngine({
    userId: 'demo-user',
    store: skillStore,
    chatId: 'skill-demo',
  }).set(
    role('You are a helpful assistant with access to specialized skills.'),
    skills({
      paths: [
        {
          host: 'packages/context/src/skills',
          sandbox: '/skills/skills',
        },
      ],
    }), // Injects <available_skills> into system prompt
  );

  // Resolve to see what the LLM receives
  const { systemPrompt } = await context.resolve({
    renderer: new XmlRenderer(),
  });

  console.log('\nSystem prompt with skills metadata:');
  console.log(systemPrompt);

  // The LLM now sees skill metadata and can read SKILL.md files when needed
  // Example flow when user asks "Create a presentation":
  // 1. LLM sees "presenterm" skill matches the request
  // 2. LLM uses readFile tool to read /path/to/presenterm/SKILL.md
  // 3. Full skill instructions now in context
  // 4. LLM follows the skill's guidance to complete the task
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
  await demonstrateVisualization();
  await demonstrateSearch();
}

function engine(...fragments: ContextFragment[]) {
  const context = new ContextEngine({
    userId: 'demo-user',
    // store: new SqliteContextStore('./context.sqlite'),
    store: new InMemoryContextStore(),
    chatId: 'demo-chat-1',
  });
  context.set(...fragments);
  return context;
}

const context = engine(
  role('You are a bad assistant.'),
  hint('Greet the user badly.'),
);

const grettingAgent = agent({
  name: 'greeting_agent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  context,
});

// Create the skill-aware agent with bash-tool
async function createSkillAwareAgent() {
  console.log('\n=== Skill-Aware Agent Demo (using bash-tool) ===');

  const { bash } = await createBashTool({
    sandbox: new Bash({
      fs: new OverlayFs({ root: process.cwd() }),
      // customCommands: createBinaryBridges(
      //   'presenterm', // Presentation tool
      //   'node', // Node.js runtime
      //   { name: 'python', binaryPath: 'python3' }, // Python with alias
      // ),
    }),
    uploadDirectory: {
      source: process.cwd(),
      include: 'packages/**/src/skills/**/*.{md,ts,json}',
    },
    onBeforeBashCall: ({ command }) => {
      console.log(chalk.blue(`[Bash Tool] Executing: ${command}`));
      return { command };
    },
    onAfterBashCall: ({ command, result }) => {
      console.log(
        chalk.blue(
          `[Bash Tool] Command "${command}" exited with code ${JSON.stringify(result)}`,
        ),
      );
      return { result };
    },
  });

  const agentContext = new ContextEngine({
    userId: 'demo-user',
    store: new InMemoryContextStore(),
    chatId: 'skill-agent-demo',
  }).set(
    role(
      `You are a helpful assistant with access to specialized skills. your main tool is bash tool to read files and execute commands on the user's behalf.`,
    ),
    skills({
      paths: [
        {
          host: 'packages/context/src/skills',
          sandbox: '/skills/skills',
        },
      ],
    }),
  );
  const skillAwareAgent = agent({
    name: 'skill_agent',
    model: groq('moonshotai/kimi-k2-instruct-0905'),
    context: agentContext,
    tools: { bash },
  });

  agentContext.set(user(`Forecast sales base on the last 4 years.`));

  const stream = await skillAwareAgent.stream({}, {});
  await printer.stdout(stream);
}

/**
 * Example: Docker Sandbox - Real Binary Execution in Containers
 *
 * Demonstrates how to use Docker sandbox for executing real system binaries
 * in isolated containers instead of simulated environments.
 *
 * Two approaches are shown:
 * 1. Low-level: createDockerSandbox() for direct container control
 * 2. High-level: createContainerTool() for AI agent integration
 */
async function demonstrateDockerSandbox() {
  console.log('\n=== Docker Sandbox Demo ===');

  // ─────────────────────────────────────────────────────────────────────────
  // Approach 1: Low-level - Direct Docker sandbox control
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Low-level: createDockerSandbox() ---');

  const sandbox = await createDockerSandbox({
    image: 'alpine:latest',
    packages: ['curl', 'jq'],
    mounts: [
      {
        hostPath: process.cwd(),
        containerPath: '/workspace',
        readOnly: true, // Read-only by default for security
      },
    ],
    resources: { memory: '512m', cpus: 1 },
  });

  try {
    // Execute commands in the container
    const result = await sandbox.executeCommand('curl --version');
    console.log('curl version:', result.stdout.split('\n')[0]);

    // Commands return stdout, stderr, and exitCode
    const lsResult = await sandbox.executeCommand('ls /workspace');
    console.log('Workspace files:', lsResult.stdout.trim().split('\n').length);

    // Write files to the container
    await sandbox.writeFiles([
      { path: '/tmp/hello.txt', content: 'Hello from Docker sandbox!' },
    ]);

    // Read files from the container
    const content = await sandbox.readFile('/tmp/hello.txt');
    console.log('File content:', content);

    // Handle command failures gracefully
    const failResult = await sandbox.executeCommand('nonexistent_command');
    console.log('Failed command exitCode:', failResult.exitCode); // 127
  } finally {
    // Always dispose to stop and remove the container
    await sandbox.dispose();
    console.log('Container cleaned up');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Approach 2: High-level - Container tool for AI agents
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- High-level: createContainerTool() ---');

  // createContainerTool combines createDockerSandbox + createBashTool
  const {
    bash,
    tools,
    sandbox: agentSandbox,
  } = await createContainerTool({
    packages: ['python3', 'nodejs'],
    mounts: [
      {
        hostPath: process.cwd(),
        containerPath: '/project',
        readOnly: false, // Allow writes for agent work
      },
    ],

    // Bash tool hooks work as expected
    onBeforeBashCall: ({ command }) => {
      console.log(chalk.cyan(`[Container] Running: ${command}`));
      return { command };
    },
    onAfterBashCall: ({ result }) => {
      if (result.exitCode !== 0) {
        console.log(chalk.yellow(`[Container] Exit code: ${result.exitCode}`));
      }
      return { result };
    },
  });

  try {
    // The bash tool can be used directly with AI SDK
    // In a real agent, you'd pass `tools` to generateText/streamText
    console.log('Available tools:', Object.keys(tools));

    // Execute via the underlying sandbox
    const pythonResult = await agentSandbox.executeCommand('python3 --version');
    console.log('Python:', pythonResult.stdout.trim());

    const nodeResult = await agentSandbox.executeCommand('node --version');
    console.log('Node.js:', nodeResult.stdout.trim());
  } finally {
    await agentSandbox.dispose();
    console.log('Agent container cleaned up');
  }
}

/**
 * Example: Docker Sandbox with Skill-Aware Agent
 *
 * Combines Docker sandbox with skills for an agent that can:
 * - Execute real binaries (python, node, presenterm, etc.)
 * - Access skill instructions via progressive disclosure
 * - Work in an isolated, reproducible environment
 */
async function createDockerSkillAgent() {
  console.log('\n=== Docker + Skills Agent Demo ===');

  // Create container tool with necessary packages
  // Note: presenterm is not available in Alpine's apk repository,
  // so we install it from pre-built binaries using the `binaries` option
  const { bash, sandbox, tools } = await createContainerTool({
    packages: ['curl', 'jq'], // curl is needed for binary downloads, jq for JSON parsing
    binaries: [
      {
        name: 'presenterm',
        url: {
          // Pre-built musl binaries for Alpine Linux
          x86_64:
            'https://github.com/mfontanini/presenterm/releases/download/v0.15.1/presenterm-0.15.1-x86_64-unknown-linux-musl.tar.gz',
          aarch64:
            'https://github.com/mfontanini/presenterm/releases/download/v0.15.1/presenterm-0.15.1-aarch64-unknown-linux-musl.tar.gz',
        },
        binaryPath: 'presenterm', // The binary name inside the tar.gz archive
      },
    ],
    mounts: [
      {
        hostPath: process.cwd(),
        containerPath: '/workspace',
        readOnly: false,
      },
    ],
    onBeforeBashCall: ({ command }) => {
      console.log(chalk.blue(`[Docker Agent] ${command}`));
      return { command };
    },
  });

  try {
    const context = new ContextEngine({
      userId: 'demo-user',
      store: new InMemoryContextStore(),
      chatId: 'docker-skill-agent',
    }).set(
      role(`You are a system admin.`),
      skills({
        paths: [
          {
            host: 'packages/context/src/skills',
            sandbox: '/skills/skills',
          },
        ],
      }),
    );

    // Create the agent
    const dockerAgent = agent({
      name: 'docker_skill_agent',
      model: groq('moonshotai/kimi-k2-instruct-0905'),
      context,
      tools: { bash },
    });

    // Example: Agent can now execute real commands
    context.set(user('Show me all installed apps.'));

    const stream = await dockerAgent.stream({}, {});
    await printer.stdout(stream);
  } finally {
    await sandbox.dispose();
  }
}

// Run the skill-aware agent demo
// await createSkillAwareAgent();

// Uncomment to run Docker sandbox demos (requires Docker)
// await demonstrateDockerSandbox();
// await createDockerSkillAgent();
