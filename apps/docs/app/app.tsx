import { useState, useRef, useEffect } from 'react';

// --- Types ---
type Page = 'HOME' | 'MODULES' | 'ARCHITECTURE';

// --- Icons ---
const Icons = {
  Terminal: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  Brain: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M17.636 17.636l-.707-.707M12 21v-1M6.364 17.636l.707-.707M3 12h1M6.364 6.364l.707.707" />
    </svg>
  ),
  Send: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
    </svg>
  ),
  Sparkles: () => (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
    </svg>
  ),
  Code: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  Cycle: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  ),
  Server: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
  ),
  Lock: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ),
  Database: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  Book: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  ),
  MessageSquare: () => (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
};

// --- Navigation ---

function Navbar({ activePage, onNavigate }: { activePage: Page; onNavigate: (p: Page) => void }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass-panel border-b-0 border-b-solar-700/30">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div
          className="flex items-center gap-2 text-solar-300 cursor-pointer"
          onClick={() => onNavigate('HOME')}
        >
          <div className="w-8 h-8 bg-solar-800 border border-solar-500 flex items-center justify-center">
            <Icons.Terminal />
          </div>
          <span className="font-bold tracking-tighter text-lg">
            DEEPAGENTS<span className="text-solar-accent">/TEXT2SQL</span>
          </span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-solar-400">
          <button
            onClick={() => onNavigate('MODULES')}
            className={`hover:text-solar-accent transition-colors ${activePage === 'MODULES' ? 'text-solar-accent' : ''}`}
          >
            MODULES
          </button>
          <button
            onClick={() => onNavigate('ARCHITECTURE')}
            className={`hover:text-solar-accent transition-colors ${activePage === 'ARCHITECTURE' ? 'text-solar-accent' : ''}`}
          >
            ARCHITECTURE
          </button>
          <a
            href="/docs/text2sql"
            className="text-solar-300 border border-solar-500 px-4 py-1.5 hover:bg-solar-500 hover:text-solar-900 transition-colors"
          >
            DOCS
          </a>
        </div>
      </div>
    </nav>
  );
}

// --- Components ---

function FeatureCard({
  title,
  icon,
  description,
  code,
  expanded,
}: {
  title: string;
  icon: React.ReactNode;
  description: string;
  code: string;
  expanded?: boolean;
}) {
  return (
    <div
      className={`border border-solar-700 bg-solar-900/50 hover:bg-solar-800/50 transition-all group relative overflow-hidden p-6 flex flex-col h-full ${expanded ? 'md:col-span-3 md:flex-row gap-8' : ''}`}
    >
      <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-solar-600 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      <div className={`${expanded ? 'flex-1' : ''}`}>
        <div className="flex items-start justify-between mb-4">
          <div className="p-2 bg-solar-800 text-solar-accent border border-solar-600/50">{icon}</div>
          <span className="text-[10px] uppercase text-solar-600 font-bold tracking-widest">
            Module Active
          </span>
        </div>
        <h3 className="text-xl font-bold text-solar-300 mb-2 group-hover:text-solar-accent transition-colors">
          {title}
        </h3>
        <p className="text-sm text-solar-500 mb-6 flex-1 leading-relaxed">{description}</p>
      </div>
      <div
        className={`bg-[#050604] p-4 rounded border border-solar-800 overflow-hidden ${expanded ? 'flex-1 min-w-[400px]' : ''}`}
      >
        <pre className="text-[10px] text-solar-400 font-mono overflow-x-auto">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

// --- Page: Architecture ---

function ArchitecturePage() {
  return (
    <div className="pt-32 pb-20 px-6 animate-in fade-in duration-500">
      <div className="max-w-7xl mx-auto">
        <div className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-solar-600/50 bg-solar-800/30 text-xs text-solar-400 mb-8">
            <Icons.Server />
            <span>SYSTEM TOPOLOGY V1.0</span>
          </div>
          <h2 className="text-4xl font-bold text-solar-300 mb-4 tracking-tight">
            SYSTEM ARCHITECTURE
          </h2>
          <p className="text-solar-500 max-w-2xl text-lg">
            A schema-aware reasoning layer bridging natural language intent and structured database
            queries. Powered by the Vercel AI SDK.
          </p>
        </div>

        {/* Visual Diagram */}
        <div className="bg-solar-900/30 border border-solar-800 p-8 rounded-xl mb-16 relative overflow-hidden">
          <div className="absolute inset-0 grid-bg opacity-50"></div>
          <div className="relative z-10 grid md:grid-cols-5 gap-4 items-center justify-center font-mono text-xs">
            {/* Node 1 */}
            <div className="p-6 border border-solar-600 bg-solar-900 rounded text-center shadow-lg">
              <div className="text-solar-accent mb-2 font-bold">CLIENT</div>
              <div className="text-solar-400">NL Query</div>
            </div>
            <div className="hidden md:flex justify-center text-solar-600">&rarr;</div>

            {/* Node 2 */}
            <div className="p-6 border border-solar-600 bg-solar-900 rounded text-center shadow-lg relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-solar-800 border border-solar-700 px-2 py-0.5 rounded text-[10px] text-solar-400">
                Grounding
              </div>
              <div className="text-solar-300 mb-2 font-bold">SCHEMA</div>
              <div className="text-solar-500">Introspection</div>
            </div>
            <div className="hidden md:flex justify-center text-solar-600">&rarr;</div>

            {/* Node 3 (Core) */}
            <div className="p-8 border-2 border-solar-accent bg-solar-900/90 rounded text-center shadow-[0_0_30px_rgba(238,187,46,0.15)] transform scale-110 z-20">
              <div className="text-solar-accent mb-2 font-bold text-lg">AI MODEL</div>
              <div className="text-solar-400 mb-2">Reasoning Engine</div>
              <div className="text-[10px] bg-solar-accent/10 text-solar-accent px-2 py-1 rounded inline-block">
                Vercel AI SDK
              </div>
            </div>
            <div className="hidden md:flex justify-center text-solar-600">&rarr;</div>

            {/* Node 4 */}
            <div className="p-6 border border-solar-600 bg-solar-900 rounded text-center shadow-lg">
              <div className="text-solar-300 mb-2 font-bold">DATABASE</div>
              <div className="text-solar-500">PostgreSQL / SQLite / MSSQL</div>
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div className="grid md:grid-cols-2 gap-12">
          <div>
            <h3 className="text-xl font-bold text-solar-300 mb-4 flex items-center gap-2 border-b border-solar-800 pb-2">
              <Icons.Code /> SCHEMA GROUNDING
            </h3>
            <p className="text-solar-500 mb-6 leading-relaxed">
              The agent ingests schema definitions via automatic introspection. Tables, views,
              indexes, constraints, and column statistics are tokenized and injected into the system
              prompt to prevent hallucination.
            </p>
            <div className="bg-[#050604] p-4 border border-solar-800 rounded font-mono text-xs text-solar-400">
              <div className="text-solar-600 mb-2">// 8 Grounding Functions</div>
              <pre>{`grounding: [
  tables(),      // Tables, columns, PKs
  views(),       // Database views
  info(),        // DB version info
  indexes(),     // Index hints
  constraints(), // Foreign keys
  rowCount(),    // Table sizes
  columnStats(), // Min/max/nulls
  lowCardinality() // Enum values
]`}</pre>
            </div>
          </div>

          <div>
            <h3 className="text-xl font-bold text-solar-300 mb-4 flex items-center gap-2 border-b border-solar-800 pb-2">
              <Icons.Book /> TEACHABLES SYSTEM
            </h3>
            <p className="text-solar-500 mb-6 leading-relaxed">
              Inject domain knowledge using 17 teachable types. Define business vocabulary,
              guardrails, examples, workflows, and user preferences. The AI learns YOUR business.
            </p>
            <div className="bg-[#050604] p-4 border border-solar-800 rounded font-mono text-xs text-solar-400">
              <div className="text-solar-600 mb-2">// Domain Knowledge</div>
              <pre>{`text2sql.instruct(
  term("ARR", "Annual Recurring Revenue"),
  guardrail({ rule: "No PII" }),
  hint("Exclude test accounts")
);`}</pre>
            </div>
          </div>

          <div className="md:col-span-2">
            <h3 className="text-xl font-bold text-solar-300 mb-4 flex items-center gap-2 border-b border-solar-800 pb-2">
              <Icons.Lock /> SECURITY & GOVERNANCE
            </h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div className="p-4 bg-solar-900/50 border border-solar-700 rounded">
                <h4 className="text-solar-accent font-bold mb-2">Read-Only Default</h4>
                <p className="text-xs text-solar-500">
                  All generated queries are read-only by default. Write operations require explicit
                  enablement.
                </p>
              </div>
              <div className="p-4 bg-solar-900/50 border border-solar-700 rounded">
                <h4 className="text-solar-accent font-bold mb-2">Guardrails</h4>
                <p className="text-xs text-solar-500">
                  Define hard boundaries the AI must never cross. Protect PII, enforce compliance
                  rules.
                </p>
              </div>
              <div className="p-4 bg-solar-900/50 border border-solar-700 rounded">
                <h4 className="text-solar-accent font-bold mb-2">Query Validation</h4>
                <p className="text-xs text-solar-500">
                  All queries are validated before execution. Syntax errors caught and reported.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Page: Modules ---

function ModulesPage() {
  return (
    <div className="pt-32 pb-20 px-6 animate-in fade-in duration-500">
      <div className="max-w-7xl mx-auto">
        <div className="mb-12">
          <h2 className="text-4xl font-bold text-solar-300 mb-4">AGENT MODULES</h2>
          <p className="text-solar-500 max-w-2xl">
            A suite of specialized cognitive modules working in tandem to deliver production-grade
            natural language to SQL capabilities.
          </p>
        </div>

        <div className="flex flex-col gap-8">
          <FeatureCard
            expanded
            title="Schema-Aware SQL Generation"
            icon={<Icons.Brain />}
            description="The core module that understands your database schema through automatic introspection. Maps tables, relationships, indexes, and constraints. Handles complex joins across multiple tables with high accuracy by grounding the AI in real schema metadata."
            code={`// Grounding Configuration
grounding: [
  tables(),
  views(),
  info(),
  indexes(),
  constraints(),
  lowCardinality()
]`}
          />

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              title="Teachable Knowledge"
              icon={<Icons.Book />}
              description="Encode domain expertise using 17 teachable types: terms, hints, guardrails, examples, workflows, glossaries, and 6 user-specific types for personalization."
              code={`text2sql.instruct(
  term("MRR", "Monthly Recurring Revenue"),
  guardrail({ rule: "Never expose PII" }),
  glossary({ "revenue": "SUM(amount)" })
);`}
            />
            <FeatureCard
              title="Streaming Conversations"
              icon={<Icons.Cycle />}
              description="Multi-turn conversations with streaming responses. Follow-up questions understand prior context. User preferences and corrections are remembered across sessions."
              code={`const stream = await text2sql.chat(
  messages,
  { chatId, userId }
);
for await (const chunk of stream) { ... }`}
            />
            <FeatureCard
              title="Explainable SQL"
              icon={<Icons.MessageSquare />}
              description="Convert SQL queries back to plain English explanations. Help users understand complex queries and validate the generated SQL matches their intent."
              code={`const explanation = await text2sql.explain(
  "SELECT dept, AVG(salary) FROM employees GROUP BY dept"
);
// "Average salary for each department..."`}
            />
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              title="PostgreSQL Adapter"
              icon={<Icons.Database />}
              description="Full PostgreSQL support with schema introspection, index hints, and constraint awareness."
              code={`import { Postgres } from '@deepagents/text2sql/postgres';`}
            />
            <FeatureCard
              title="SQLite Adapter"
              icon={<Icons.Database />}
              description="Lightweight SQLite adapter perfect for embedded databases and local development."
              code={`import { Sqlite } from '@deepagents/text2sql/sqlite';`}
            />
            <FeatureCard
              title="SQL Server Adapter"
              icon={<Icons.Database />}
              description="Enterprise SQL Server support with T-SQL generation and MSSQL-specific optimizations."
              code={`import { SqlServer } from '@deepagents/text2sql/sqlserver';`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Terminal Demo Component ---

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isSql?: boolean;
}

function TerminalDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const mockResponses: Record<string, string> = {
    'show me top customers by revenue': `SELECT
  customer_id,
  customer_name,
  SUM(order_total) as total_revenue
FROM customers c
JOIN orders o ON c.id = o.customer_id
WHERE o.created_at >= DATE_TRUNC('quarter', CURRENT_DATE)
GROUP BY customer_id, customer_name
ORDER BY total_revenue DESC
LIMIT 10;`,
    'how many orders last month': `SELECT COUNT(*) as order_count
FROM orders
WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
  AND created_at < DATE_TRUNC('month', CURRENT_DATE);`,
    'average order value by product category': `SELECT
  p.category,
  AVG(oi.quantity * oi.unit_price) as avg_order_value
FROM order_items oi
JOIN products p ON oi.product_id = p.id
GROUP BY p.category
ORDER BY avg_order_value DESC;`,
  };

  const handleSend = () => {
    if (!input.trim()) return;
    setLoading(true);

    const userMessage: ChatMessage = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    const query = input.toLowerCase().trim();
    setInput('');

    setTimeout(() => {
      const response =
        mockResponses[query] ||
        `SELECT *
FROM your_table
WHERE condition = 'value'
-- Generated from: "${query}"
LIMIT 100;`;

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
          isSql: true,
        },
      ]);
      setLoading(false);
    }, 800);
  };

  return (
    <div className="w-full h-full flex flex-col gap-4">
      {/* Terminal Header */}
      <div className="flex items-center justify-between border-b border-solar-700 pb-2">
        <div className="flex gap-2">
          <span className="text-xs px-3 py-1 border rounded border-solar-accent text-solar-accent bg-solar-accent/10">
            SQL_MODE
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-solar-600 uppercase">
          <div
            className={`w-2 h-2 rounded-full ${loading ? 'bg-solar-accent animate-ping' : 'bg-solar-500'}`}
          ></div>
          {loading ? 'GENERATING' : 'READY'}
        </div>
      </div>

      {/* Terminal Output */}
      <div
        ref={scrollRef}
        className="flex-1 bg-[#050604] rounded border border-solar-800 p-4 overflow-y-auto min-h-[300px] max-h-[400px] font-mono text-sm relative"
      >
        {messages.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-solar-800 pointer-events-none select-none">
            <div className="text-4xl mb-2 opacity-50">
              <Icons.Terminal />
            </div>
            <p>TRY: "show me top customers by revenue"</p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className="mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-baseline gap-2 mb-1">
              <span
                className={`text-xs font-bold ${msg.role === 'user' ? 'text-solar-accent' : 'text-solar-500'}`}
              >
                {msg.role === 'user' ? 'USER@TEXT2SQL:~$' : 'SQL::OUTPUT>'}
              </span>
              <span className="text-[10px] text-solar-700">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>

            <div
              className={`pl-4 border-l ${msg.role === 'user' ? 'border-solar-800' : 'border-solar-600'}`}
            >
              <pre className="whitespace-pre-wrap text-solar-300 leading-relaxed font-mono">
                {msg.content}
              </pre>
            </div>
          </div>
        ))}

        {loading && (
          <div className="pl-4 border-l border-solar-800 text-solar-600 animate-pulse">
            <span className="inline-block w-2 h-4 bg-solar-600 align-middle"></span>
          </div>
        )}
      </div>

      {/* Terminal Input */}
      <div className="flex gap-2 items-end bg-solar-900/50 p-2 rounded border border-solar-800">
        <div className="flex-1 relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask a question about your data..."
            className="w-full bg-transparent border-none text-solar-300 placeholder-solar-700 focus:ring-0 h-9 font-mono focus:outline-none"
          />
        </div>

        <button
          onClick={handleSend}
          disabled={loading}
          className="text-solar-400 hover:text-solar-accent disabled:opacity-50 transition-colors px-2"
        >
          <Icons.Send />
        </button>
      </div>
    </div>
  );
}

// --- Page: Home ---

function Hero({ onNavigate }: { onNavigate: (p: Page) => void }) {
  return (
    <section className="pt-32 pb-20 px-6 border-b border-solar-700/30 relative overflow-hidden animate-in fade-in duration-500">
      <div className="absolute top-20 right-0 opacity-10 pointer-events-none">
        <pre className="text-[10px] leading-3 text-solar-500">
          {`
      .           .
    /' \\         / \\
   /   | .---.  |   \\
  |    |/  _  \\|    |
  |    |\\  _  /|    |
   \\   | '---'  |   /
    \\./         \\./
      |   .---.   |
      |  /  _  \\  |
      | |  (_)  | |
      |  \\  _  /  |
      |   '---'   |
`}
        </pre>
      </div>
      <div className="max-w-7xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-solar-600/50 bg-solar-800/30 text-xs text-solar-400 mb-8">
          <span className="w-2 h-2 rounded-full bg-solar-accent animate-pulse"></span>
          <span>OPENAI / ANTHROPIC / GOOGLE / GROQ</span>
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-solar-300 mb-6 leading-[0.9]">
          ASK QUESTIONS.
          <br />
          <span className="text-solar-accent">GET SQL.</span>
        </h1>
        <p className="text-xl text-solar-500 max-w-2xl mb-10 font-light leading-relaxed">
          AI-powered natural language to SQL that learns your business. Schema-aware generation with
          teachable domain knowledge. Multi-database support.
        </p>
        <div className="flex flex-col md:flex-row gap-4">
          <button
            onClick={() => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })}
            className="h-14 px-8 bg-solar-accent text-solar-900 font-bold text-lg flex items-center justify-center gap-2 hover:bg-yellow-400 transition-colors border border-transparent hover:border-solar-300"
          >
            <Icons.Terminal /> TRY DEMO
          </button>
          <div className="h-14 px-8 border border-solar-600 text-solar-400 font-medium text-lg flex items-center justify-center gap-2 font-mono">
            $ npm install @deepagents/text2sql
          </div>
        </div>
      </div>
    </section>
  );
}

function DemoSection() {
  return (
    <section id="demo" className="py-24 px-6 bg-solar-900/30 border-b border-solar-700/30">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-solar-300 mb-4">INTERACTIVE PLAYGROUND</h2>
          <p className="text-solar-500 max-w-2xl mx-auto">
            Experience natural language to SQL generation. Ask questions in plain English and see
            the generated queries.
          </p>
        </div>

        <div className="glass-panel p-1 rounded-xl shadow-[0_0_50px_rgba(43,51,34,0.2)]">
          <div className="bg-solar-900/90 rounded-lg p-6 border border-solar-700/50">
            <TerminalDemo />
          </div>
        </div>
      </div>
    </section>
  );
}

function HomePage({ onNavigate }: { onNavigate: (p: Page) => void }) {
  return (
    <>
      <Hero onNavigate={onNavigate} />

      {/* Teaser Features for Home */}
      <section className="py-12 px-6 border-b border-solar-700/30 bg-solar-900/20">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-end justify-between mb-8">
            <h2 className="text-2xl font-bold text-solar-300">CAPABILITIES</h2>
            <button
              onClick={() => onNavigate('MODULES')}
              className="text-solar-accent text-sm hover:underline"
            >
              VIEW ALL MODULES &rarr;
            </button>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard
              title="Schema-Aware Generation"
              icon={<Icons.Brain />}
              description="Automatic introspection of tables, relationships, indexes, and constraints for accurate query generation."
              code="grounding: [tables(), indexes()]"
            />
            <FeatureCard
              title="Teachable Knowledge"
              icon={<Icons.Book />}
              description="Encode domain expertise with 17 teachable types: terms, hints, guardrails, examples, glossaries, and more."
              code='term("MRR", "Monthly Recurring Revenue")'
            />
            <FeatureCard
              title="Multi-Database Support"
              icon={<Icons.Database />}
              description="PostgreSQL, SQLite, and SQL Server adapters with database-specific optimizations."
              code='import { Postgres } from "@deepagents/text2sql/postgres"'
            />
          </div>
        </div>
      </section>

      <DemoSection />

      {/* Code Example Section */}
      <section className="py-24 px-6 border-b border-solar-700/30">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-solar-300 mb-4 text-center">QUICK START</h2>
          <p className="text-solar-500 max-w-2xl mx-auto text-center mb-12">
            Get up and running in minutes with a simple setup.
          </p>

          <div className="bg-[#050604] rounded-lg border border-solar-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-solar-800 bg-solar-900/50">
              <span className="text-xs text-solar-500 font-mono">quick-start.ts</span>
              <span className="text-[10px] text-solar-600">TypeScript</span>
            </div>
            <pre className="p-6 text-sm text-solar-400 font-mono overflow-x-auto">
              <code>{`import { Text2Sql, InMemoryHistory } from '@deepagents/text2sql';
import { Postgres, tables, indexes, constraints } from '@deepagents/text2sql/postgres';

const text2sql = new Text2Sql({
  version: 'v1',
  adapter: new Postgres({
    execute: async (sql) => pool.query(sql).then(r => r.rows),
    grounding: [tables(), indexes(), constraints()],
  }),
  history: new InMemoryHistory(),
});

// Generate SQL from natural language
const sql = await text2sql.toSql(
  "Show me the top 10 customers by revenue"
);`}</code>
            </pre>
          </div>
        </div>
      </section>
    </>
  );
}

function Footer({ onNavigate }: { onNavigate: (p: Page) => void }) {
  return (
    <footer className="py-12 px-6 bg-[#050604] text-center md:text-left border-t border-solar-800">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
        <div>
          <div className="flex items-center justify-center md:justify-start gap-2 text-solar-400 mb-2">
            <Icons.Terminal />
            <span className="font-bold tracking-tighter">@DEEPAGENTS/TEXT2SQL</span>
          </div>
          <p className="text-xs text-solar-600">
            &copy; 2025 JanuaryLabs
            <br />
            MIT License
          </p>
        </div>
        <div className="flex gap-6 text-xs text-solar-500 font-mono">
          <button onClick={() => onNavigate('MODULES')} className="hover:text-solar-accent">
            MODULES
          </button>
          <button onClick={() => onNavigate('ARCHITECTURE')} className="hover:text-solar-accent">
            ARCHITECTURE
          </button>
          <a href="/docs/text2sql" className="hover:text-solar-accent">
            DOCS
          </a>
          <a href="https://github.com/JanuaryLabs/deepagents" className="hover:text-solar-accent">
            GITHUB
          </a>
        </div>
      </div>
    </footer>
  );
}

// --- Main Layout ---

export default function App() {
  const [activePage, setActivePage] = useState<Page>('HOME');

  return (
    <div className="min-h-screen flex flex-col bg-solar-900">
      <Navbar activePage={activePage} onNavigate={setActivePage} />
      <main className="flex-1">
        {activePage === 'HOME' && <HomePage onNavigate={setActivePage} />}
        {activePage === 'MODULES' && <ModulesPage />}
        {activePage === 'ARCHITECTURE' && <ArchitecturePage />}
      </main>
      <Footer onNavigate={setActivePage} />
    </div>
  );
}
