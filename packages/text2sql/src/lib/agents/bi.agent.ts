/**
 * BI Agent - Business Intelligence dashboard generator
 *
 * This agent creates dashboard specifications using HTML custom elements.
 * It outputs markdown with embedded kebab-case HTML tags that the
 * frontend parses. Charts contain SQL queries that the frontend
 * executes independently.
 *
 * Workflow:
 * 1. Analyze request and plan metrics
 * 2. Output dashboard with row/col/grid layout and chart components
 */
import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { agent, toState } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';

/**
 * State passed to the BI agent
 */
export type BiAgentState = {
  /** Database adapter for query execution and validation */
  adapter: Adapter;
  /** Schema introspection XML */
  introspection: string;
  /** Combined teachings/instructions string */
  teachings: string;
};

/**
 * Tools available to the BI agent for SQL validation and reasoning
 */
const tools = {
  /**
   * Validate SQL query syntax without executing.
   * Use this to verify queries are correct before embedding in dashboard components.
   */
  validate_query: tool({
    description: dedent`
      Validate SQL query syntax before embedding in dashboard components.
      Use this to verify your queries are syntactically correct and reference valid tables/columns.

      This tool does NOT execute the query or return data.
      Only SELECT or WITH statements are allowed.
    `,
    inputSchema: z.object({
      reasoning: z
        .string()
        .describe(
          'Why this query helps understand the data for dashboard design.',
        ),
      sql: z
        .string()
        .min(1, { message: 'SQL query cannot be empty.' })
        .refine(
          (sql) =>
            sql.trim().toUpperCase().startsWith('SELECT') ||
            sql.trim().toUpperCase().startsWith('WITH'),
          {
            message: 'Only read-only SELECT or WITH queries are allowed.',
          },
        )
        .describe('The SQL query to validate.'),
    }),
    execute: async ({ sql }, options) => {
      const state = toState<BiAgentState>(options);
      const result = await state.adapter.validate(sql);
      if (typeof result === 'string') {
        return { valid: false, error: result };
      }
      return { valid: true };
    },
  }),

  /**
   * Record insights and reasoning during schema analysis and dashboard design.
   */
  scratchpad: scratchpad_tool,
};

/**
 * HTML component documentation for the agent prompt
 */
const COMPONENTS_DOC = dedent`
  ## Available Components

  You output markdown with embedded HTML custom elements. Use kebab-case tags with closing tags.

  ### Chart Components

  #### Area Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<area-chart>\` | \`title\`, \`sql\` | \`x-key\`, \`y-key\`, \`variant\` | Cumulative values, trends with volume |

  **Variants** (use \`variant\` prop):
  - \`default\` - Basic area with smooth curves
  - \`linear\` - Sharp-edged lines showing precise changes
  - \`step\` - Step-based segments for discrete data
  - \`stacked\` - Multiple series stacked on top of each other
  - \`stacked-expand\` - Normalized to 100% showing percentage contribution
  - \`gradient\` - Filled with gradient for visual depth

  #### Bar Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<bar-chart>\` | \`title\`, \`sql\` | \`x-key\`, \`y-key\`, \`variant\`, \`orientation\` | Categorical comparisons, grouped data |

  **Variants** (use \`variant\` prop):
  - \`default\` - Basic vertical bars
  - \`multiple\` - Multiple series side by side
  - \`stacked\` - Multiple series stacked
  - \`labeled\` - With value labels on bars
  - \`negative\` - Supports positive/negative values with conditional coloring
  - \`mixed\` - Different colors per category

  **Orientation** (use \`orientation\` prop):
  - \`vertical\` (default) - Vertical bars
  - \`horizontal\` - Horizontal bars (good for long category names)

  #### Line Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<line-chart>\` | \`title\`, \`sql\` | \`x-key\`, \`y-key\`, \`variant\` | Trends over time, continuous data |

  **Variants** (use \`variant\` prop):
  - \`default\` - Smooth curved lines
  - \`linear\` - Straight lines between points
  - \`step\` - Step-based transitions
  - \`dots\` - Lines with visible data point markers
  - \`multiple\` - Multiple series for comparisons (A/B testing, etc.)
  - \`interactive\` - With metric switching capability
  - \`labeled\` - With value labels at each point

  #### Pie & Donut Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<pie-chart>\` | \`title\`, \`sql\` | \`label-key\`, \`value-key\`, \`variant\` | Part-to-whole relationships, distributions |
  | \`<donut-chart>\` | \`title\`, \`sql\` | \`label-key\`, \`value-key\`, \`variant\` | Same as pie but with center space for text/KPI |

  **Variants** (use \`variant\` prop):
  - \`default\` - Basic pie/donut
  - \`labeled\` - With labels on segments
  - \`legend\` - With external legend
  - \`interactive\` - With hover highlighting and selection
  - \`stacked\` - Multiple concentric rings for comparison

  #### Radar Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<radar-chart>\` | \`title\`, \`sql\` | \`label-key\`, \`value-key\`, \`variant\` | Multi-dimensional comparisons, skill assessments |

  **Variants** (use \`variant\` prop):
  - \`default\` - Basic radar with polygon grid
  - \`dots\` - With visible data point markers
  - \`filled\` - With filled area
  - \`multiple\` - Multiple series overlapping
  - \`circle\` - Circular grid instead of polygon
  - \`legend\` - With integrated legend

  #### Radial Charts
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<radial-chart>\` | \`title\`, \`sql\` | \`value-key\`, \`variant\` | Progress indicators, gauges, circular metrics |

  **Variants** (use \`variant\` prop):
  - \`default\` - Basic radial bars from center outward
  - \`text\` - With centered value/caption text
  - \`shape\` - Gauge-style arc (not full circle)
  - \`stacked\` - Concentric arcs for multiple metrics
  - \`grid\` - With background grid rings

  #### KPI Component
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<kpi>\` | \`title\`, \`sql\` | \`variant\`, \`format\`, \`trend-sql\`, \`target\`, \`icon\`, \`description\`, \`color\` | Rich metric displays with trends, progress, sparklines |

  **Variants** (use \`variant\` prop):
  - \`default\` - Simple value card
  - \`trend\` - Value with change indicator (↑12.5% or ↓3.2%)
  - \`comparison\` - Value with previous period value shown
  - \`progress\` - Value with horizontal progress bar toward target
  - \`ring\` - Value with circular progress gauge toward target
  - \`sparkline\` - Value with mini area chart showing recent trend

  **Props Reference**:
  - \`title\` (required) - Display label
  - \`sql\` (required) - Query returning \`{ value: number }\`
  - \`variant\` - Display style (see above)
  - \`format\` - Value format: \`currency\`, \`percent\`, \`number\`, \`compact\`, \`duration\`
  - \`trend-sql\` - Query for trend data:
    - For \`trend\`/\`comparison\`: returns \`{ change: number }\` or \`{ previous: number }\`
    - For \`sparkline\`: returns time-series \`[{ date, value }]\`
  - \`target\` - Target value for \`progress\`/\`ring\` variants
  - \`icon\` - Icon identifier: \`dollar\`, \`users\`, \`cart\`, \`chart\`, \`percent\`, \`clock\`
  - \`description\` - Subtitle/context text
  - \`color\` - Accent color: \`positive\` (green), \`negative\` (red), \`neutral\`, \`primary\`

  #### Data Table
  | Component | Required Props | Optional Props | Use Case |
  |-----------|----------------|----------------|----------|
  | \`<data-table>\` | \`title\`, \`sql\` | \`columns\` | Detailed data, lists, rankings |

  ### Layout Components
  | Component | Props | Description |
  |-----------|-------|-------------|
  | \`<row>\` | \`gap?\` | Horizontal flex container (small, medium, or large) |
  | \`<column>\` | \`span\` (1-12) | Column within row, 12-column grid |
  | \`<grid>\` | \`cols\`, \`gap?\` | CSS Grid container |

  ### Chart Selection Guide
  - **Time series / Trends with volume**: Use \`<area-chart>\` (shows magnitude over time)
  - **Time series / Precise trends**: Use \`<line-chart>\` (clean trend lines)
  - **Categories / Comparisons**: Use \`<bar-chart>\`
  - **Part-to-whole / Proportions**: Use \`<pie-chart>\` or \`<donut-chart>\`
  - **Multi-dimensional comparisons**: Use \`<radar-chart>\` (e.g., comparing skills, features)
  - **Progress / Gauges**: Use \`<radial-chart>\` (circular progress indicators)
  - **Detailed data / Rankings**: Use \`<data-table>\`
  - **Single metrics**: Use \`<kpi>\` with appropriate variant:
    - Simple value → \`default\`
    - Value with change indicator → \`trend\`
    - Value vs previous period → \`comparison\`
    - Value toward goal → \`progress\` or \`ring\`
    - Value with recent history → \`sparkline\`

  ### Example Output
  \`\`\`markdown
  ## Sales Dashboard

  <row>
    <column span="3">
      <kpi
        title="Total Revenue"
        sql="SELECT SUM(amount) as value FROM orders"
        trend-sql="SELECT ((SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN amount END) - SUM(CASE WHEN created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days' THEN amount END)) / NULLIF(SUM(CASE WHEN created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days' THEN amount END), 0) * 100) as change FROM orders"
        variant="trend"
        format="currency"
        icon="dollar">
      </kpi>
    </column>
    <column span="3">
      <kpi
        title="Orders Today"
        sql="SELECT COUNT(*) as value FROM orders WHERE DATE(created_at) = CURRENT_DATE"
        trend-sql="SELECT DATE(created_at) as date, COUNT(*) as value FROM orders WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 1"
        variant="sparkline"
        icon="cart">
      </kpi>
    </column>
    <column span="3">
      <kpi
        title="Sales Target"
        sql="SELECT SUM(amount) as value FROM orders WHERE EXTRACT(QUARTER FROM created_at) = EXTRACT(QUARTER FROM NOW())"
        target="100000"
        variant="progress"
        format="currency"
        description="Q4 2024 Goal">
      </kpi>
    </column>
    <column span="3">
      <kpi
        title="Conversion Rate"
        sql="SELECT (COUNT(DISTINCT buyer_id)::float / COUNT(DISTINCT visitor_id) * 100) as value FROM sessions"
        variant="ring"
        target="100"
        format="percent"
        color="primary">
      </kpi>
    </column>
  </row>

  <row>
    <column span="8">
      <area-chart
        title="Revenue Over Time"
        sql="SELECT DATE_TRUNC('month', created_at) as month, SUM(amount) as revenue FROM orders GROUP BY 1 ORDER BY 1"
        x-key="month"
        y-key="revenue"
        variant="gradient">
      </area-chart>
    </column>
    <column span="4">
      <donut-chart
        title="Revenue by Category"
        sql="SELECT category, SUM(amount) as revenue FROM orders GROUP BY category"
        label-key="category"
        value-key="revenue"
        variant="interactive">
      </donut-chart>
    </column>
  </row>

  <row>
    <column span="6">
      <bar-chart
        title="Monthly Comparison"
        sql="SELECT DATE_TRUNC('month', created_at) as month, SUM(CASE WHEN EXTRACT(YEAR FROM created_at) = 2024 THEN amount END) as this_year, SUM(CASE WHEN EXTRACT(YEAR FROM created_at) = 2023 THEN amount END) as last_year FROM orders GROUP BY 1"
        variant="multiple"
        x-key="month">
      </bar-chart>
    </column>
    <column span="6">
      <radar-chart
        title="Product Performance"
        sql="SELECT metric, score FROM product_metrics WHERE product_id = 1"
        label-key="metric"
        value-key="score"
        variant="filled">
      </radar-chart>
    </column>
  </row>

  <data-table
    title="Top 10 Products"
    sql="SELECT name, SUM(quantity) as sold, SUM(amount) as revenue FROM order_items GROUP BY name ORDER BY revenue DESC LIMIT 10">
  </data-table>
  \`\`\`
`;

export const biAgent = agent<never, BiAgentState>({
  model: groq('gpt-oss-20b'),
  tools,
  name: 'bi_agent',
  prompt: (state) => {
    return dedent`
      You are an expert BI analyst that creates dashboard specifications using HTML custom elements.

      ${COMPONENTS_DOC}

      ## Your Workflow

      1. **PLAN**: Analyze the request and schema to determine what metrics/visualizations to create
      2. **VALIDATE**: Use \`validate_query\` to verify SQL syntax is correct before embedding
      3. **OUTPUT**: Generate the dashboard using layout and chart components

      ## Critical Rules

      - **Design from schema**: Use the provided schema introspection to understand available tables, columns, and relationships
      - **Validate all queries**: Use \`validate_query\` to ensure SQL is syntactically correct before embedding in components
      - **Use kebab-case HTML tags** with closing tags (e.g., \`<bar-chart></bar-chart>\`)
      - Use \`scratchpad\` to record schema analysis insights and design decisions
      - Choose chart types based on column types (dates → line/area, categories → bar/pie, numbers → KPI)
      - Use layout components (row, column, grid) to organize the dashboard
      - Include a text introduction explaining what the dashboard shows

      ## SQL Rules

      - Only SELECT or WITH statements
      - Use proper date/time functions for the database
      - Include appropriate GROUP BY, ORDER BY clauses
      - Use aliases for calculated columns

      ${state?.teachings || ''}
      ${state?.introspection || ''}
    `;
  },
});
