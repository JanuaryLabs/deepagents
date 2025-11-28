## Planning

This is one of the surprisingly complex modules to build. When you understand it, you think "oh, that makes sense," but getting there is tricky and sometimes does not make sense at all.

You hear about adding planning to an AI Agent, which means creating a plan for how the agent should execute and achieve the job at hand. A plan is typically a set of steps the agent needs to run to get there. This works until it does not. The first question at hand is: what if midway through, the agent started operating on a false premise because the steps no longer make sense given the agent's current state of execution?

So you think, okay, let's replan after each step, but this time the planner needs to be aware of the previous steps' results.

This approach works, but it consumes far more tokens than you might have initially anticipated.

---

This design is formally known as "Plan and Solve." It consists of four components:

- user message
- planner agent
- executor agent
- replanner agent

The planner creates a set of steps based on the user message.
The executor runs the steps one by one, but before moving to the next step, it checks the plan through the replanner agent. If any changes are needed, it outputs them and then repeats the loop until the replanner confirms that all is good and the plan is completed.

## Memory

---

User Memory: What to Remember About the Human

1. Identity & Role

What to store:

- Who is this user? (name, role, department)
- What's their technical level? (analyst, executive, engineer)
- What's their domain? (finance, marketing, ops)

Why it matters:

- Executive → simpler explanations, high-level summaries
- Analyst → detailed data, show the SQL
- Finance person → understands revenue terms, not engineering jargon

Example adaptation:
For executive: "Revenue is up 12% this quarter"
For analyst: "SELECT SUM(amount) ... returned $4.2M, up from $3.75M"

---

2. Vocabulary & Terminology

What to store:

- How does THIS user refer to things?
- Their personal shorthand and jargon

Examples:

- "When I say 'customers', I mean B2B accounts, not individual consumers"
- "GMV means Gross Merchandise Value"
- "'The big table' = the orders table"
- "Q4 means Oct-Dec, not our fiscal Q4"

Why it matters:

- Avoids repeated clarification
- Personalizes interpretation

---

3. Preferences

What to store:

- How do they like results presented?
- Default behaviors they've established

Examples:

- "Always show dates as YYYY-MM-DD"
- "I prefer bar charts over tables for comparisons"
- "Limit results to 50 rows unless I ask for more"
- "Always include the SQL in your response"
- "Don't explain unless I ask"

---

4. Access & Permissions

What to store:

- What can this user see/query?
- What's off-limits?

Examples:

- "User can only see data for region = 'EMEA'"
- "Salary and PII columns are restricted"
- "Read-only access to production"

Why it matters:

- Security
- Automatically filter queries to their scope
- Don't show data they can't access

---

5. Working Context (Short-term)

What to store:

- What are they currently working on?
- What's the active project/focus?

Examples:

- "Currently analyzing Q4 performance"
- "Preparing for board meeting on Thursday"
- "Investigating the drop in signups last week"

Why it matters:

- Informs defaults: "Show me revenue" → assumes Q4 context
- Better suggestions: "Want to see signups by channel?"
- Continuity across sessions

---

6. History & Patterns

What to store:

- What do they ask about frequently?
- When do they typically use the system?
- What tables/metrics do they care about?

Examples:

- "Usually asks about revenue and orders"
- "Never queries the inventory table"
- "Runs weekly Monday morning reports"

Why it matters:

- Proactive suggestions
- Personalized onboarding
- Surface relevant golden queries

---

7. Corrections & Clarifications

What to store:

- When they corrected the system, what did they say?
- Clarifications they've made

Examples:

- "When I say 'active', I mean logged in within 30 days, not subscription status"
- "The status column: 1 = active, 0 = inactive"
- "Don't use the legacy_orders table, use orders_v2"

Why it matters:

- Don't repeat mistakes for THIS user
- Their mental model is captured

---

The Memory Lifecycle

┌─────────────────────────────────────────────────────────────┐
│ USER MEMORY │
├─────────────────────────────────────────────────────────────┤
│ │
│ EXPLICIT (User tells us) IMPLICIT (We observe) │
│ ───────────────────────── ────────────────────── │
│ • "I'm in finance" • Always asks about revenue │
│ • "Call me Alex" • Prefers tables over charts │
│ • "I mean B2B customers" • Queries orders table 80% │
│ • "Use YYYY-MM-DD dates" • Active Mon-Fri 9am-5pm │
│ │
│ ↓ ↓ │
│ ┌──────────────────────────────────┐ │
│ │ USER PROFILE │ │
│ │ (Persisted across sessions) │ │
│ └──────────────────────────────────┘ │
│ ↓ │
│ ┌──────────────────────────────────┐ │
│ │ PROMPT PERSONALIZATION │ │
│ │ • Inject preferences │ │
│ │ • Apply vocabulary │ │
│ │ • Respect access rules │ │
│ │ • Add working context │ │
│ └──────────────────────────────────┘ │
│ │
└─────────────────────────────────────────────────────────────┘

---

How to Capture User Memory

| Type     | Capture Method                                |
| -------- | --------------------------------------------- |
| Explicit | User says "Remember that..." or "I prefer..." |
| Explicit | Settings/preferences UI                       |
| Explicit | Onboarding questionnaire                      |
| Implicit | Track query patterns over time                |
| Implicit | Observe corrections and learn                 |
| Implicit | Note what they ignore vs. engage with         |

---

Your Existing User Profile

You already have UserProfileStore in memory/user-profile.ts with:

- Facts: Identity information
- Preferences: User preferences
- Present: Current working context

This is the right structure! The question is:

1. How to populate it (explicit vs. implicit)
2. How to use it (where in the prompt, how much weight)
3. When to update it (every session? on explicit command?)

---

Key Design Questions for User Memory

1. Explicit vs. Implicit capture?
    - Explicit: "Remember I only care about EMEA"
    - Implicit: Detect they always filter to EMEA

2. Persistence scope?
    - Per database connection?
    - Per user globally?
    - Per user-database combination?

3. Transparency?
    - Can user see what's remembered?
    - Can they edit/delete memories?
    - "What do you know about me?"

4. Conflict resolution?
    - Old preference vs. new behavior
    - Explicit override vs. implicit pattern

---

What aspects of user memory are you most interested in exploring? The capture mechanism? The storage structure? How it gets injected into prompts? Or the UX of managing what's remembered?
