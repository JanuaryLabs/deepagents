import { tool } from 'ai';
import Conf from 'conf';
import { z } from 'zod';

/**
 * Memory System - Inspired by human memory architecture
 *
 * This system implements a multi-layered memory architecture:
 *
 * 1. Working Memory: Short-term, context-specific information (current conversation)
 * 2. Episodic Memory: Event-based memories with temporal context
 * 3. Semantic Memory: Facts, concepts, and general knowledge
 * 4. Procedural Memory: Learned patterns and associations
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'episodic' | 'semantic' | 'procedural';
  timestamp: number;
  tags: string[];
  importance: number; // 1-10 scale
  accessCount: number;
  lastAccessed: number;
  context?: Record<string, any>;
  relationships?: string[]; // IDs of related memories
  decay?: number; // Memory strength (0-1)
}

export interface MemoryQuery {
  query: string;
  type?: 'episodic' | 'semantic' | 'procedural';
  limit?: number;
  minImportance?: number;
  tags?: string[];
  timeRange?: { start?: number; end?: number };
}

export interface MemoryStats {
  totalMemories: number;
  byType: Record<string, number>;
  mostAccessed: MemoryEntry[];
  recentMemories: MemoryEntry[];
  averageImportance: number;
}

// ============================================================================
// Memory Store Implementation
// ============================================================================

export class MemoryStore {
  private store: Conf<{
    memories: Record<string, MemoryEntry>;
    relationships: Record<string, string[]>;
    metadata: {
      lastConsolidation: number;
      totalAccesses: number;
    };
  }>;

  constructor(name = 'agent-memory') {
    this.store = new Conf({
      projectName: name,
      schema: {
        memories: {
          type: 'object',
          default: {},
        },
        relationships: {
          type: 'object',
          default: {},
        },
        metadata: {
          type: 'object',
          default: {
            lastConsolidation: Date.now(),
            totalAccesses: 0,
          },
        },
      },
    }) as Conf<{
      memories: Record<string, MemoryEntry>;
      relationships: Record<string, string[]>;
      metadata: {
        lastConsolidation: number;
        totalAccesses: number;
      };
    }>;
  }

  /**
   * Generate a unique memory ID
   */
  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Calculate memory decay based on time and access patterns
   */
  private calculateDecay(memory: MemoryEntry): number {
    const now = Date.now();
    const age = now - memory.timestamp;
    const timeSinceAccess = now - memory.lastAccessed;

    // Ebbinghaus forgetting curve approximation
    const daysSinceCreation = age / (1000 * 60 * 60 * 24);
    const daysSinceAccess = timeSinceAccess / (1000 * 60 * 60 * 24);

    // Decay slows with repeated access (spacing effect)
    const accessBonus = Math.log(memory.accessCount + 1) * 0.1;
    const importanceBonus = memory.importance * 0.05;

    const decay = Math.max(
      0.1,
      1 -
        (daysSinceCreation * 0.05 +
          daysSinceAccess * 0.08 -
          accessBonus -
          importanceBonus),
    );

    return Math.min(1, decay);
  }

  /**
   * Store a new memory
   */
  write(
    entry: Omit<
      MemoryEntry,
      'id' | 'timestamp' | 'accessCount' | 'lastAccessed' | 'decay'
    >,
  ): MemoryEntry {
    const id = this.generateId();
    const now = Date.now();

    const memory: MemoryEntry = {
      ...entry,
      id,
      timestamp: now,
      accessCount: 0,
      lastAccessed: now,
      decay: 1.0,
    };

    const memories = this.store.get('memories');
    memories[id] = memory;
    this.store.set('memories', memories);

    // Update relationships if provided
    if (entry.relationships && entry.relationships.length > 0) {
      const relationships = this.store.get('relationships');
      for (const relatedId of entry.relationships) {
        if (!relationships[relatedId]) {
          relationships[relatedId] = [];
        }
        if (!relationships[relatedId].includes(id)) {
          relationships[relatedId].push(id);
        }
      }
      this.store.set('relationships', relationships);
    }

    return memory;
  }

  /**
   * Retrieve a memory by ID
   */
  get(id: string): MemoryEntry | null {
    const memories = this.store.get('memories');
    const memory = memories[id];

    if (!memory) {
      return null;
    }

    // Update access metrics
    memory.accessCount++;
    memory.lastAccessed = Date.now();
    memory.decay = this.calculateDecay(memory);

    memories[id] = memory;
    this.store.set('memories', memories);

    // Update global access count
    const metadata = this.store.get('metadata');
    metadata.totalAccesses++;
    this.store.set('metadata', metadata);

    return memory;
  }

  /**
   * Search memories based on query
   */
  lookup(query: MemoryQuery): MemoryEntry[] {
    const memories = Object.values(this.store.get('memories'));

    let results = memories;

    // Filter by type
    if (query.type) {
      results = results.filter((m) => m.type === query.type);
    }

    // Filter by importance
    if (query.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= query.minImportance!);
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) =>
        query.tags!.some((tag) => m.tags.includes(tag)),
      );
    }

    // Filter by time range
    if (query.timeRange) {
      if (query.timeRange.start) {
        results = results.filter((m) => m.timestamp >= query.timeRange!.start!);
      }
      if (query.timeRange.end) {
        results = results.filter((m) => m.timestamp <= query.timeRange!.end!);
      }
    }

    // Text search (simple implementation)
    const searchTerms = query.query.toLowerCase().split(' ');
    results = results.filter((m) => {
      const content = m.content.toLowerCase();
      const tags = m.tags.join(' ').toLowerCase();
      return searchTerms.some(
        (term) => content.includes(term) || tags.includes(term),
      );
    });

    // Update decay for all matching memories
    results = results.map((m) => ({
      ...m,
      decay: this.calculateDecay(m),
    }));

    // Sort by relevance (combination of decay, importance, and recency)
    results.sort((a, b) => {
      const scoreA =
        (a.decay || 0) * a.importance * (1 + Math.log(a.accessCount + 1));
      const scoreB =
        (b.decay || 0) * b.importance * (1 + Math.log(b.accessCount + 1));
      return scoreB - scoreA;
    });

    // Limit results
    const limit = query.limit || 10;
    return results.slice(0, limit);
  }

  /**
   * Update an existing memory
   */
  correct(
    id: string,
    updates: Partial<Omit<MemoryEntry, 'id' | 'timestamp'>>,
  ): MemoryEntry | null {
    const memories = this.store.get('memories');
    const memory = memories[id];

    if (!memory) {
      return null;
    }

    const updated = {
      ...memory,
      ...updates,
      id: memory.id, // Preserve ID
      timestamp: memory.timestamp, // Preserve original timestamp
      lastAccessed: Date.now(),
      accessCount: memory.accessCount + 1,
    };

    updated.decay = this.calculateDecay(updated);

    memories[id] = updated;
    this.store.set('memories', memories);

    return updated;
  }

  /**
   * Delete a memory (forget)
   */
  forget(id: string): boolean {
    const memories = this.store.get('memories');

    if (!memories[id]) {
      return false;
    }

    delete memories[id];
    this.store.set('memories', memories);

    // Clean up relationships
    const relationships = this.store.get('relationships');
    delete relationships[id];

    // Remove references from other memories
    for (const [key, refs] of Object.entries(relationships)) {
      relationships[key] = refs.filter((ref) => ref !== id);
    }

    this.store.set('relationships', relationships);

    return true;
  }

  /**
   * Get related memories
   */
  getRelated(id: string, limit = 5): MemoryEntry[] {
    const relationships = this.store.get('relationships');
    const relatedIds = relationships[id] || [];

    const memories = this.store.get('memories');
    const relatedMemories = relatedIds
      .map((relId) => memories[relId])
      .filter(Boolean)
      .slice(0, limit);

    return relatedMemories;
  }

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    const memories = Object.values(this.store.get('memories'));

    const byType = memories.reduce(
      (acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const mostAccessed = [...memories]
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10);

    const recentMemories = [...memories]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);

    const averageImportance =
      memories.length > 0
        ? memories.reduce((sum, m) => sum + m.importance, 0) / memories.length
        : 0;

    return {
      totalMemories: memories.length,
      byType,
      mostAccessed,
      recentMemories,
      averageImportance,
    };
  }

  /**
   * Consolidate memories (prune low-importance, rarely accessed memories)
   */
  consolidate(threshold = 0.2): number {
    const memories = this.store.get('memories');
    const entries = Object.entries(memories);

    let pruned = 0;
    for (const [id, memory] of entries) {
      const decay = this.calculateDecay(memory);
      if (decay < threshold && memory.importance < 5) {
        delete memories[id];
        pruned++;
      }
    }

    if (pruned > 0) {
      this.store.set('memories', memories);

      const metadata = this.store.get('metadata');
      metadata.lastConsolidation = Date.now();
      this.store.set('metadata', metadata);
    }

    return pruned;
  }

  /**
   * Clear all memories
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Export all memories
   */
  export(): Record<string, MemoryEntry> {
    return this.store.get('memories');
  }

  /**
   * Import memories
   */
  import(memories: Record<string, MemoryEntry>): void {
    this.store.set('memories', memories);
  }

  // ============================================================================
  // Specialized Write Functions - High-level convenience methods
  // ============================================================================

  /**
   * Write a semantic memory (facts, concepts, general knowledge)
   *
   * @example
   * store.writeSemantic("React is a JavaScript library for building UIs", {
   *   tags: ["react", "javascript"],
   *   importance: 8
   * });
   */
  writeSemantic(
    content: string,
    options?: {
      importance?: number;
      tags?: string[];
      context?: Record<string, any>;
      relationships?: string[];
    },
  ): MemoryEntry {
    return this.write({
      content,
      type: 'semantic',
      importance: options?.importance ?? 7, // Default to 7 for facts
      tags: options?.tags ?? [],
      context: options?.context,
      relationships: options?.relationships,
    });
  }

  /**
   * Write an episodic memory (events, conversations, experiences)
   *
   * @example
   * store.writeEpisodic("User completed onboarding", {
   *   tags: ["milestone", "user123"],
   *   context: { userId: "user123", timestamp: Date.now() }
   * });
   */
  writeEpisodic(
    content: string,
    options?: {
      importance?: number;
      tags?: string[];
      context?: Record<string, any>;
      relationships?: string[];
    },
  ): MemoryEntry {
    return this.write({
      content,
      type: 'episodic',
      importance: options?.importance ?? 6, // Default to 6 for events
      tags: options?.tags ?? [],
      context: {
        ...options?.context,
        timestamp: options?.context?.timestamp ?? Date.now(),
      },
      relationships: options?.relationships,
    });
  }

  /**
   * Write a procedural memory (patterns, behaviors, methods)
   *
   * @example
   * store.writeProcedural("When user asks for help, first check documentation", {
   *   tags: ["pattern", "help"],
   *   importance: 7
   * });
   */
  writeProcedural(
    content: string,
    options?: {
      importance?: number;
      tags?: string[];
      context?: Record<string, any>;
      relationships?: string[];
    },
  ): MemoryEntry {
    return this.write({
      content,
      type: 'procedural',
      importance: options?.importance ?? 7, // Default to 7 for patterns
      tags: options?.tags ?? [],
      context: options?.context,
      relationships: options?.relationships,
    });
  }

  /**
   * Store a user preference (convenience wrapper for semantic memory)
   *
   * @example
   * store.storePreference("user123", "theme", "dark");
   */
  storePreference(
    userId: string,
    preference: string,
    value: any,
    importance = 8,
  ): MemoryEntry {
    return this.writeSemantic(
      `User ${userId} prefers ${preference}: ${typeof value === 'object' ? JSON.stringify(value) : value}`,
      {
        importance,
        tags: ['preference', userId, preference],
        context: {
          userId,
          preference,
          value,
          category: 'user-preference',
        },
      },
    );
  }

  /**
   * Record a conversation exchange (convenience wrapper for episodic memory)
   *
   * @example
   * store.recordConversation("user123", "session456", "user", "How do I use React hooks?");
   */
  recordConversation(
    userId: string,
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    message: string,
    importance = 5,
  ): MemoryEntry {
    return this.writeEpisodic(`[${role}]: ${message}`, {
      importance,
      tags: ['conversation', userId, sessionId, role],
      context: {
        userId,
        sessionId,
        role,
        timestamp: Date.now(),
        category: 'conversation',
      },
    });
  }

  /**
   * Record a user action/event (convenience wrapper for episodic memory)
   *
   * @example
   * store.recordAction("user123", "completed_tutorial", { tutorialId: "intro" });
   */
  recordAction(
    userId: string,
    action: string,
    details?: Record<string, any>,
    importance = 6,
  ): MemoryEntry {
    return this.writeEpisodic(`User ${userId} performed action: ${action}`, {
      importance,
      tags: ['action', userId, action],
      context: {
        userId,
        action,
        details,
        timestamp: Date.now(),
        category: 'user-action',
      },
    });
  }

  /**
   * Learn a pattern from observations (convenience wrapper for procedural memory)
   *
   * @example
   * store.learnPattern("optimization-workflow", "Profile before optimizing", {
   *   conditions: "Performance issues reported",
   *   relatedMemories: ["mem_123"]
   * });
   */
  learnPattern(
    patternName: string,
    description: string,
    options?: {
      importance?: number;
      conditions?: string;
      relatedMemories?: string[];
      context?: Record<string, any>;
    },
  ): MemoryEntry {
    return this.writeProcedural(`Pattern [${patternName}]: ${description}`, {
      importance: options?.importance ?? 7,
      tags: ['pattern', 'learned', patternName],
      context: {
        patternName,
        conditions: options?.conditions,
        category: 'learned-pattern',
        ...options?.context,
      },
      relationships: options?.relatedMemories,
    });
  }

  /**
   * Store a fact or knowledge (convenience wrapper for semantic memory)
   *
   * @example
   * store.storeFact("JavaScript", "JavaScript is a programming language", {
   *   source: "documentation",
   *   relatedTo: ["mem_456"]
   * });
   */
  storeFact(
    topic: string,
    fact: string,
    options?: {
      importance?: number;
      source?: string;
      relatedTo?: string[];
      tags?: string[];
    },
  ): MemoryEntry {
    return this.writeSemantic(fact, {
      importance: options?.importance ?? 7,
      tags: ['fact', 'knowledge', topic, ...(options?.tags ?? [])],
      context: {
        topic,
        source: options?.source,
        category: 'fact',
      },
      relationships: options?.relatedTo,
    });
  }

  /**
   * Record a milestone or achievement (convenience wrapper for episodic memory)
   *
   * @example
   * store.recordMilestone("user123", "first-project-completed", "User completed their first project");
   */
  recordMilestone(
    userId: string,
    milestoneType: string,
    description: string,
    importance = 7,
  ): MemoryEntry {
    return this.writeEpisodic(description, {
      importance,
      tags: ['milestone', userId, milestoneType],
      context: {
        userId,
        milestoneType,
        timestamp: Date.now(),
        category: 'milestone',
      },
    });
  }

  /**
   * Store contextual information about current session (working memory)
   * Note: These should have lower importance as they're temporary
   *
   * @example
   * store.storeSessionContext("session456", "user-preferences-loaded", { theme: "dark" });
   */
  storeSessionContext(
    sessionId: string,
    contextKey: string,
    data: any,
    importance = 4,
  ): MemoryEntry {
    return this.writeEpisodic(`Session context [${contextKey}]`, {
      importance,
      tags: ['session', 'working-memory', sessionId, contextKey],
      context: {
        sessionId,
        contextKey,
        data,
        category: 'session-context',
        timestamp: Date.now(),
      },
    });
  }

  // ============================================================================
  // Proactive Memory Loading - Auto-inject memories into system prompt
  // ============================================================================

  /**
   * Get proactive memories that should always be present in system prompt
   * These are high-importance memories that provide essential context
   *
   * @param options Configuration for proactive memory retrieval
   * @returns Formatted string ready for system prompt injection
   *
   * @example
   * const memoryContext = memoryStore.getProactiveMemories({
   *   userId: 'user123',
   *   minImportance: 7,
   *   categories: ['preference', 'core-knowledge']
   * });
   *
   * // Use in agent:
   * const systemPrompt = `${basePrompt}\n\n${memoryContext}`;
   */
  getProactiveMemories(options: {
    userId?: string;
    sessionId?: string;
    minImportance?: number;
    categories?: string[];
    maxMemories?: number;
    types?: Array<'episodic' | 'semantic' | 'procedural'>;
    includeRelationships?: boolean;
  }): string {
    const {
      userId,
      sessionId,
      minImportance = 7, // High importance by default
      categories = [],
      maxMemories = 10,
      types,
      includeRelationships = false,
    } = options;

    // Build tags filter
    const tags: string[] = [];
    if (userId) tags.push(userId);
    if (sessionId) tags.push(sessionId);
    if (categories.length > 0) tags.push(...categories);

    // Collect memories by type
    const memoriesByType: Record<string, MemoryEntry[]> = {
      semantic: [],
      procedural: [],
      episodic: [],
    };

    const typesToFetch = types || ['semantic', 'procedural', 'episodic'];

    for (const type of typesToFetch) {
      const memories = this.lookup({
        query: '', // Empty query to get all matching filters
        type: type as 'episodic' | 'semantic' | 'procedural',
        minImportance,
        tags: tags.length > 0 ? tags : undefined,
        limit: maxMemories,
      });
      memoriesByType[type] = memories;
    }

    // Format memories for system prompt
    return this.formatProactiveMemories(memoriesByType, includeRelationships);
  }

  /**
   * Format proactive memories into a structured system prompt section
   */
  private formatProactiveMemories(
    memoriesByType: Record<string, MemoryEntry[]>,
    includeRelationships: boolean,
  ): string {
    const sections: string[] = [];

    // Semantic memories (facts, preferences, knowledge)
    if (memoriesByType.semantic.length > 0) {
      sections.push('## Core Knowledge & Preferences');
      sections.push('');
      memoriesByType.semantic.forEach((mem, idx) => {
        sections.push(`${idx + 1}. ${mem.content}`);
        if (mem.context?.preference) {
          sections.push(`   - Preference: ${mem.context.preference}`);
        }
        if (mem.context?.source) {
          sections.push(`   - Source: ${mem.context.source}`);
        }
      });
      sections.push('');
    }

    // Procedural memories (patterns, workflows)
    if (memoriesByType.procedural.length > 0) {
      sections.push('## Behavioral Patterns & Guidelines');
      sections.push('');
      memoriesByType.procedural.forEach((mem, idx) => {
        sections.push(`${idx + 1}. ${mem.content}`);
        if (mem.context?.conditions) {
          sections.push(`   - When: ${mem.context.conditions}`);
        }
        if (mem.context?.patternName) {
          sections.push(`   - Pattern: ${mem.context.patternName}`);
        }
      });
      sections.push('');
    }

    // Episodic memories (recent important events)
    if (memoriesByType.episodic.length > 0) {
      sections.push('## Recent Context & History');
      sections.push('');
      memoriesByType.episodic.forEach((mem, idx) => {
        const timeAgo = this.formatTimeAgo(Date.now() - mem.timestamp);
        sections.push(`${idx + 1}. ${mem.content} (${timeAgo})`);
        if (mem.context?.milestoneType) {
          sections.push(`   - Milestone: ${mem.context.milestoneType}`);
        }
      });
      sections.push('');
    }

    if (sections.length === 0) {
      return '';
    }

    return [
      '',
      '# Proactive Memory Context',
      'The following information has been retrieved from memory to provide you with essential context:',
      '',
      ...sections,
    ].join('\n');
  }

  /**
   * Helper to format time ago for human readability
   */
  private formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  /**
   * Get user-specific proactive memories
   * Convenience method that focuses on user preferences and patterns
   *
   * @example
   * const userContext = memoryStore.getUserProactiveMemories('user123');
   */
  getUserProactiveMemories(
    userId: string,
    options?: {
      includePreferences?: boolean;
      includePatterns?: boolean;
      includeRecentHistory?: boolean;
      maxPerCategory?: number;
    },
  ): string {
    const {
      includePreferences = true,
      includePatterns = true,
      includeRecentHistory = true,
      maxPerCategory = 5,
    } = options || {};

    const types: Array<'episodic' | 'semantic' | 'procedural'> = [];
    const categories: string[] = [];

    if (includePreferences) {
      types.push('semantic');
      categories.push('preference');
    }

    if (includePatterns) {
      types.push('procedural');
      categories.push('pattern');
    }

    if (includeRecentHistory) {
      types.push('episodic');
      categories.push('milestone', 'action');
    }

    return this.getProactiveMemories({
      userId,
      minImportance: 7,
      categories,
      maxMemories: maxPerCategory * types.length,
      types: types.length > 0 ? types : undefined,
    });
  }

  /**
   * Get session-specific proactive memories
   * Focuses on working memory and recent context
   *
   * @example
   * const sessionContext = memoryStore.getSessionProactiveMemories('session456');
   */
  getSessionProactiveMemories(
    sessionId: string,
    options?: {
      includeWorkingMemory?: boolean;
      maxMemories?: number;
    },
  ): string {
    const { includeWorkingMemory = true, maxMemories = 10 } = options || {};

    const categories = includeWorkingMemory
      ? ['session', 'working-memory', 'conversation']
      : ['session', 'conversation'];

    return this.getProactiveMemories({
      sessionId,
      minImportance: 4, // Lower threshold for session context
      categories,
      maxMemories,
      types: ['episodic'],
    });
  }

  /**
   * Get critical memories that should ALWAYS be present
   * These are importance level 9-10 memories
   *
   * @example
   * const criticalContext = memoryStore.getCriticalMemories();
   */
  getCriticalMemories(options?: {
    userId?: string;
    maxMemories?: number;
  }): string {
    return this.getProactiveMemories({
      userId: options?.userId,
      minImportance: 9,
      maxMemories: options?.maxMemories || 5,
      types: ['semantic', 'procedural'],
    });
  }

  /**
   * Build complete proactive context for an agent
   * Combines critical, user-specific, and session-specific memories
   *
   * @example
   * const fullContext = memoryStore.buildProactiveContext({
   *   userId: 'user123',
   *   sessionId: 'session456'
   * });
   *
   * // Use in agent system prompt
   * const systemPrompt = `${basePrompt}\n\n${fullContext}`;
   */
  buildProactiveContext(options: {
    userId?: string;
    sessionId?: string;
    includeCritical?: boolean;
    includeUser?: boolean;
    includeSession?: boolean;
  }): string {
    const {
      userId,
      sessionId,
      includeCritical = true,
      includeUser = true,
      includeSession = true,
    } = options;

    const sections: string[] = [];

    // Critical memories first
    if (includeCritical) {
      const critical = this.getCriticalMemories({ userId });
      if (critical) sections.push(critical);
    }

    // User-specific context
    if (includeUser && userId) {
      const userContext = this.getUserProactiveMemories(userId);
      if (userContext) sections.push(userContext);
    }

    // Session-specific context
    if (includeSession && sessionId) {
      const sessionContext = this.getSessionProactiveMemories(sessionId);
      if (sessionContext) sections.push(sessionContext);
    }

    return sections.join('\n\n');
  }
}

// ============================================================================
// Memory Tools for AI Agents
// ============================================================================

// Create a singleton memory store instance
export const memoryStore = new MemoryStore();

/**
 * Tool: Lookup memories
 */
export const memoryLookup = tool({
  description: `Search and retrieve memories from the memory store.
    Use this to recall past conversations, learned facts, or previous interactions.
    Memories decay over time but are reinforced through repeated access.`,
  inputSchema: z.object({
    query: z.string().describe('Search query to find relevant memories'),
    type: z
      .enum(['episodic', 'semantic', 'procedural'])
      .optional()
      .describe('Type of memory to search'),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(10)
      .describe('Maximum number of memories to retrieve'),
    minImportance: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe('Minimum importance level (1-10)'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
  }),
  execute: async ({ query, type, limit, minImportance, tags }) => {
    console.log('Memory lookup:', { query, type, limit, minImportance, tags });

    const results = memoryStore.lookup({
      query,
      type,
      limit,
      minImportance,
      tags,
    });

    return {
      count: results.length,
      memories: results.map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        importance: m.importance,
        tags: m.tags,
        timestamp: new Date(m.timestamp).toISOString(),
        accessCount: m.accessCount,
        decay: m.decay?.toFixed(2),
        context: m.context,
      })),
    };
  },
});

/**
 * Tool: Explain a specific memory
 */
export const memoryExplain = tool({
  description: `Get detailed information about a specific memory, including its relationships,
    access history, and decay status. Use this to understand the context and relevance of a memory.`,
  inputSchema: z.object({
    id: z.string().describe('The unique identifier of the memory to explain'),
    includeRelated: z
      .boolean()
      .default(true)
      .describe('Include related memories in the explanation'),
  }),
  execute: async ({ id, includeRelated }) => {
    console.log('Memory explain:', { id, includeRelated });

    const memory = memoryStore.get(id);

    if (!memory) {
      return {
        found: false,
        message: `No memory found with ID: ${id}`,
      };
    }

    const related = includeRelated ? memoryStore.getRelated(id) : [];

    return {
      found: true,
      memory: {
        id: memory.id,
        content: memory.content,
        type: memory.type,
        importance: memory.importance,
        tags: memory.tags,
        timestamp: new Date(memory.timestamp).toISOString(),
        lastAccessed: new Date(memory.lastAccessed).toISOString(),
        accessCount: memory.accessCount,
        decay: memory.decay?.toFixed(2),
        context: memory.context,
        age: {
          days: Math.floor(
            (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24),
          ),
          hours: Math.floor((Date.now() - memory.timestamp) / (1000 * 60 * 60)),
        },
        timeSinceAccess: {
          days: Math.floor(
            (Date.now() - memory.lastAccessed) / (1000 * 60 * 60 * 24),
          ),
          hours: Math.floor(
            (Date.now() - memory.lastAccessed) / (1000 * 60 * 60),
          ),
        },
      },
      related: related.map((r) => ({
        id: r.id,
        content:
          r.content.substring(0, 100) + (r.content.length > 100 ? '...' : ''),
        type: r.type,
        importance: r.importance,
      })),
    };
  },
});

/**
 * Tool: Write a new memory
 */
export const memoryWrite = tool({
  description: `Store a new memory in the memory system. Use this to remember important facts,
    events, or learnings. Choose the appropriate memory type:
    - episodic: Events, conversations, experiences with temporal context
    - semantic: Facts, concepts, general knowledge
    - procedural: Patterns, methods, learned behaviors`,
  inputSchema: z.object({
    content: z.string().describe('The content of the memory to store'),
    type: z
      .enum(['episodic', 'semantic', 'procedural'])
      .describe('Type of memory'),
    importance: z
      .number()
      .min(1)
      .max(10)
      .default(5)
      .describe('Importance level (1-10), affects retention'),
    tags: z
      .array(z.string())
      .default([])
      .describe('Tags for categorization and retrieval'),
    context: z
      .record(z.any(), z.any())
      .optional()
      .describe('Additional context metadata'),
    relationships: z
      .array(z.string())
      .optional()
      .describe('IDs of related memories'),
  }),
  execute: async ({
    content,
    type,
    importance,
    tags,
    context,
    relationships,
  }) => {
    console.log('Memory write:', { content, type, importance, tags });

    const memory = memoryStore.write({
      content,
      type,
      importance,
      tags,
      context,
      relationships,
    });

    return {
      success: true,
      id: memory.id,
      message: 'Memory stored successfully',
      memory: {
        id: memory.id,
        type: memory.type,
        importance: memory.importance,
        timestamp: new Date(memory.timestamp).toISOString(),
      },
    };
  },
});

/**
 * Tool: Forget a memory
 */
export const memoryForget = tool({
  description: `Delete a memory from the memory store. Use this to remove outdated,
    incorrect, or irrelevant memories. This action is irreversible.`,
  inputSchema: z.object({
    id: z.string().describe('The unique identifier of the memory to forget'),
    reason: z.string().optional().describe('Optional reason for forgetting'),
  }),
  execute: async ({ id, reason }) => {
    console.log('Memory forget:', { id, reason });

    const success = memoryStore.forget(id);

    return {
      success,
      message: success
        ? `Memory ${id} has been forgotten${reason ? `: ${reason}` : ''}`
        : `No memory found with ID: ${id}`,
    };
  },
});

/**
 * Tool: Correct a memory
 */
export const memoryCorrect = tool({
  description: `Update or correct an existing memory. Use this to fix errors,
    add new information, or adjust importance levels. The original timestamp is preserved.`,
  inputSchema: z.object({
    id: z.string().describe('The unique identifier of the memory to correct'),
    updates: z.object({
      content: z.string().optional().describe('Updated content'),
      importance: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe('Updated importance'),
      tags: z.array(z.string()).optional().describe('Updated tags'),
      context: z
        .record(z.any(), z.any())
        .optional()
        .describe('Updated context'),
      relationships: z
        .array(z.string())
        .optional()
        .describe('Updated relationships'),
    }),
    correctionNote: z
      .string()
      .optional()
      .describe('Note explaining the correction'),
  }),
  execute: async ({ id, updates, correctionNote }) => {
    console.log('Memory correct:', { id, updates, correctionNote });

    const memory = memoryStore.correct(id, updates);

    if (!memory) {
      return {
        success: false,
        message: `No memory found with ID: ${id}`,
      };
    }

    return {
      success: true,
      message: `Memory ${id} has been updated${correctionNote ? `: ${correctionNote}` : ''}`,
      memory: {
        id: memory.id,
        content: memory.content,
        type: memory.type,
        importance: memory.importance,
        lastAccessed: new Date(memory.lastAccessed).toISOString(),
      },
    };
  },
});

/**
 * Tool: Get memory statistics
 */
export const memoryStats = tool({
  description: `Get statistics about the memory system, including total memories,
    distribution by type, most accessed memories, and recent memories.`,
  inputSchema: z.object({}),
  execute: async () => {
    console.log('Memory stats requested');

    const stats = memoryStore.getStats();

    return {
      total: stats.totalMemories,
      byType: stats.byType,
      averageImportance: stats.averageImportance.toFixed(2),
      mostAccessed: stats.mostAccessed.slice(0, 5).map((m) => ({
        id: m.id,
        content: m.content.substring(0, 50) + '...',
        accessCount: m.accessCount,
        type: m.type,
      })),
      recent: stats.recentMemories.slice(0, 5).map((m) => ({
        id: m.id,
        content: m.content.substring(0, 50) + '...',
        timestamp: new Date(m.timestamp).toISOString(),
        type: m.type,
      })),
    };
  },
});

// Export all tools as a collection
export const memoryTools = {
  memoryLookup,
  memoryExplain,
  memoryWrite,
  memoryForget,
  memoryCorrect,
  memoryStats,
};

// Export default
export default {
  memoryStore,
  memoryTools,
  MemoryStore,
};
