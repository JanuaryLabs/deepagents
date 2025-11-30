Queryable Objects

  TableGrounding - Include specific tables
  new TableGrounding(/^user_/)  // tables starting with "user_"
  new TableGrounding(["orders", "order_items", "products"])
  → LLM can query: SELECT * FROM users WHERE...

  ---
  ViewGrounding - Include views (pre-built abstractions)
  new ViewGrounding(/^v_/)  // views starting with "v_"
  new ViewGrounding(["v_active_users", "v_monthly_sales"])
  → Database has: CREATE VIEW v_active_users AS SELECT * FROM users WHERE status = 'active'
  → LLM can query: SELECT * FROM v_active_users (simpler than knowing the filter logic)

  ---
  MaterializedViewGrounding - Cached query results
  new MaterializedViewGrounding(["mv_daily_stats", "mv_user_aggregates"])
  → Database has: CREATE MATERIALIZED VIEW mv_daily_stats AS SELECT date, COUNT(*) FROM events GROUP BY date
  → LLM prefers this over scanning millions of rows in events

  ---
  FunctionGrounding - Table-returning functions
  new FunctionGrounding(["get_user_orders(user_id)", "search_products(query)"])
  → Database has: CREATE FUNCTION get_user_orders(uid INT) RETURNS TABLE (...)
  → LLM can query: SELECT * FROM get_user_orders(123)

  ---
  Metadata

  IndexGrounding - Hint which columns are fast to filter/sort
  new IndexGrounding(["users.email", "orders.created_at"])
  // or auto-detect from DB
  new IndexGrounding({ auto: true })
  → LLM learns: "filtering by email is fast, filtering by bio requires full scan"
  → LLM prefers: WHERE email = ? over WHERE bio LIKE ? when possible

  ---
  RelationshipGrounding - Explicit JOIN paths
  new RelationshipGrounding([
    { from: "orders.user_id", to: "users.id" },
    { from: "order_items.order_id", to: "orders.id" },
  ])
  // or auto-detect from foreign keys
  new RelationshipGrounding({ auto: true })
  → LLM knows how to JOIN: orders JOIN users ON orders.user_id = users.id

  ---
  ConstraintGrounding - Valid value hints from CHECK constraints
  new ConstraintGrounding({ auto: true })
  // discovers: CHECK (status IN ('active', 'inactive', 'pending'))
  → LLM learns: status column only has 3 valid values
  → LLM won't generate: WHERE status = 'deleted'

  ---
  Semantic Layer

  DescriptionGrounding - Human-readable explanations
  new DescriptionGrounding({
    "users.mrr": "Monthly Recurring Revenue in cents",
    "orders.gmv": "Gross Merchandise Value before discounts",
    "users.ltv": "Lifetime Value = total revenue from this user",
  })
  → User asks: "show me high-value customers"
  → LLM understands: use ltv column, not just order_count

  ---
  SampleGrounding - Example data to show patterns
  new SampleGrounding({
    tables: ["users", "orders"],
    rows: 3,  // fetch 3 sample rows per table
  })
  // or provide static samples
  new SampleGrounding({
    "users.status": ["active", "churned", "trial"],
    "orders.currency": ["USD", "EUR", "GBP"],
  })
  → LLM sees actual data format: dates are 2024-01-15, not Jan 15, 2024
  → LLM knows valid enum values without CHECK constraints

  ---
  GlossaryGrounding - Business terms → technical mapping
  new GlossaryGrounding({
    "revenue": "SUM(orders.total_amount)",
    "active user": "users WHERE last_login > NOW() - INTERVAL '30 days'",
    "churn": "users WHERE status = 'churned'",
    "power user": "users WHERE order_count > 10",
  })
  → User asks: "revenue from power users"
  → LLM translates: SELECT SUM(total_amount) FROM orders JOIN users ON ... WHERE order_count > 10

  ---
  Query Patterns

  ExampleGrounding - Few-shot learning from Q&A pairs
  new ExampleGrounding([
    {
      question: "How many users signed up last month?",
      sql: "SELECT COUNT(*) FROM users WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')"
    },
    {
      question: "Top 10 products by revenue",
      sql: "SELECT p.name, SUM(oi.quantity * oi.price) as revenue FROM products p JOIN order_items oi ON ... GROUP BY p.id ORDER BY revenue DESC LIMIT 10"
    },
  ])
  → LLM learns your SQL style, date handling patterns, preferred JOINs

  ---
  TemplateGrounding - Reusable query fragments
  new TemplateGrounding({
    "date_filter": "created_at >= {{start}} AND created_at < {{end}}",
    "active_users_cte": "WITH active AS (SELECT * FROM users WHERE status = 'active')",
    "standard_user_join": "JOIN users u ON u.id = {{table}}.user_id",
  })
  → LLM reuses consistent patterns across queries

  ---