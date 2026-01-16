import type { ContextFragment } from '../fragments.ts';

/**
 * User-specific fragment builders.
 *
 * These fragments capture user context, preferences, and personalization data
 * that can be injected into AI prompts to tailor responses.
 *
 * @example
 * ```ts
 * import { identity, persona, preference } from '@deepagents/context';
 *
 * context.set(
 *   identity({ name: 'John', role: 'VP of Sales' }),
 *   persona({ name: 'Freya', role: 'Data Assistant', tone: 'professional' }),
 *   preference('date format', 'YYYY-MM-DD'),
 * );
 * ```
 */

/**
 * Define the user's identity including name and/or role.
 *
 * Use this to capture who the user is and what lens they view data through.
 * Helps tailor explanations, terminology, and focus areas.
 *
 * @param input.name - The user's name (optional)
 * @param input.role - The user's role or position (optional)
 *
 * @example
 * identity({ name: "John", role: "VP of Sales" })
 * identity({ role: "Data analyst in the marketing team" })
 * identity({ name: "Sarah" })
 * identity({ role: "Finance manager focused on cost optimization" })
 */
export function identity(input: {
  name?: string;
  role?: string;
}): ContextFragment {
  return {
    name: 'identity',
    data: {
      ...(input.name && { name: input.name }),
      ...(input.role && { role: input.role }),
    },
  };
}

/**
 * Define an AI persona with a name, role, objective, and communication tone.
 *
 * Use this to customize the assistant's identity and what it should accomplish.
 *
 * @param input.name - The persona's name
 * @param input.role - The persona's expertise/identity (what they are)
 * @param input.objective - What the persona should accomplish (the goal)
 * @param input.tone - The communication style (e.g., friendly, professional, concise)
 *
 * @example
 * persona({ name: "DataBot", role: "SQL Expert", objective: "Generate accurate SQL queries from natural language" })
 * persona({ name: "QueryMaster", role: "Database Analyst", objective: "Help users explore database schemas" })
 */
export function persona(input: {
  name: string;
  role?: string;
  objective?: string;
  tone?: string;
}): ContextFragment {
  return {
    name: 'persona',
    data: {
      name: input.name,
      ...(input.role && { role: input.role }),
      ...(input.objective && { objective: input.objective }),
      ...(input.tone && { tone: input.tone }),
    },
  };
}

/**
 * Define user-specific term meanings and vocabulary.
 *
 * Use this when the user has their own definitions for terms that might
 * differ from standard or domain definitions. Like `term()` but personal.
 *
 * @param term - The term the user uses
 * @param meaning - What the user means by this term
 *
 * @example
 * alias("revenue", "gross revenue before deductions, not net")
 * alias("active users", "users who logged in within the last 30 days")
 * alias("the big table", "the orders table")
 * alias("Q4", "October through December, not fiscal Q4")
 */
export function alias(term: string, meaning: string): ContextFragment {
  return {
    name: 'alias',
    data: { term, meaning },
  };
}

/**
 * Define how the user prefers results presented.
 *
 * Use this to capture output formatting, style, and behavioral preferences
 * that should apply to all interactions with this user.
 *
 * @param aspect - What aspect of output this preference applies to
 * @param value - The user's preference
 *
 * @example
 * preference("date format", "YYYY-MM-DD")
 * preference("output style", "tables over charts unless trend data")
 * preference("detail level", "always show the SQL query in responses")
 * preference("row limit", "default to 50 rows unless I ask for more")
 * preference("explanation style", "brief and to the point")
 */
export function preference(aspect: string, value: string): ContextFragment {
  return {
    name: 'preference',
    data: { aspect, value },
  };
}

/**
 * Define the user's current working focus or project.
 *
 * Use this to capture temporary context that helps inform defaults,
 * assumptions, and suggestions. Should be updated as focus changes.
 *
 * @param description - What the user is currently working on
 *
 * @example
 * userContext("Preparing Q4 board presentation")
 * userContext("Investigating drop in signups last week")
 * userContext("Working on EMEA regional analysis for strategy meeting")
 * userContext("Debugging discrepancy in revenue numbers")
 */
export function userContext(description: string): ContextFragment {
  return {
    name: 'userContext',
    data: description,
  };
}

/**
 * Record a correction the user made to previous understanding.
 *
 * Use this when the user corrects a misunderstanding about data, columns,
 * or business logic. Prevents repeating the same mistake.
 *
 * @param subject - What was misunderstood
 * @param clarification - The correct understanding
 *
 * @example
 * correction("status column", "1 = active, 0 = inactive, not boolean true/false")
 * correction("orders table", "Use orders_v2, not the deprecated legacy_orders table")
 * correction("date field", "order_date is when order was placed, ship_date is when shipped")
 * correction("revenue calculation", "Must exclude refunds and chargebacks")
 */
export function correction(
  subject: string,
  clarification: string,
): ContextFragment {
  return {
    name: 'correction',
    data: { subject, clarification },
  };
}
