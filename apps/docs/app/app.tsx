import { useEffect, useRef, useState } from 'react';

// ===== Animation Components =====

function TypingText({
  text,
  speed = 50,
  delay = 0,
  onComplete,
}: {
  text: string;
  speed?: number;
  delay?: number;
  onComplete?: () => void;
}) {
  const [displayed, setDisplayed] = useState('');
  const [showCursor, setShowCursor] = useState(true);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const startTimer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(startTimer);
  }, [delay]);

  useEffect(() => {
    if (!started) return;

    let i = 0;
    const timer = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
      } else {
        clearInterval(timer);
        onComplete?.();
      }
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed, started, onComplete]);

  useEffect(() => {
    const blink = setInterval(() => setShowCursor((c) => !c), 530);
    return () => clearInterval(blink);
  }, []);

  return (
    <span>
      {displayed}
      <span
        className={`inline-block w-2 bg-[#00ff00] ${showCursor ? 'opacity-100' : 'opacity-0'}`}
      >
        ▌
      </span>
    </span>
  );
}

function AnimatedCounter({
  target,
  duration = 2000,
}: {
  target: string;
  duration?: number;
}) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  const numericTarget = parseInt(target, 10);
  const isNumeric = !isNaN(numericTarget);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.5 }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started || !isNumeric) return;

    const steps = 60;
    const increment = numericTarget / steps;
    let current = 0;

    const timer = setInterval(() => {
      current += increment;
      if (current >= numericTarget) {
        setCount(numericTarget);
        clearInterval(timer);
      } else {
        setCount(Math.floor(current));
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [started, numericTarget, isNumeric, duration]);

  return <span ref={ref}>{isNumeric ? count : target}</span>;
}

function SQLReveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  return (
    <div
      className={`transition-all duration-300 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
    >
      {children}
    </div>
  );
}

// ===== UI Components =====

function CopyButton({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`relative cursor-pointer transition-colors hover:text-[#00ff00] hover:drop-shadow-[0_0_8px_rgba(0,255,0,0.5)] ${className}`}
      title="Copy to clipboard"
    >
      {copied ? (
        <span className="text-[#00ff00] drop-shadow-[0_0_8px_rgba(0,255,0,0.5)]">
          [COPIED]
        </span>
      ) : (
        <span>[COPY]</span>
      )}
    </button>
  );
}

function TerminalWindow({
  children,
  title = 'user@text2sql:~/analytics',
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-border bg-muted">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex gap-2">
          <div className="h-3 w-3 rounded-full bg-red-500" />
          <div className="h-3 w-3 rounded-full bg-yellow-500" />
          <div className="h-3 w-3 rounded-full bg-[#00ff00]" />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{title}</span>
      </div>
      {/* Body */}
      <div className="p-6 font-mono text-sm leading-relaxed">{children}</div>
      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border bg-card px-4 py-1 text-xs text-muted-foreground">
        <span>INSERT</span>
        <span>UTF-8</span>
        <span>LF</span>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-[#00ff00]/50 hover:shadow-lg hover:shadow-[#00ff00]/10">
      <div className="mb-4 font-mono text-2xl text-[#00ff00] drop-shadow-[0_0_8px_rgba(0,255,0,0.3)]">
        {icon}
      </div>
      <h3 className="mb-3 text-lg font-bold text-foreground">{title}</h3>
      <p className="leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function CodeBlock({
  filename,
  children,
  code,
}: {
  filename: string;
  children: React.ReactNode;
  code: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2 text-sm text-muted-foreground">
        <span className="font-mono">── {filename} ──</span>
        <CopyButton text={code} />
      </div>
      <div className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
        <pre className="whitespace-pre-wrap">{children}</pre>
      </div>
    </div>
  );
}

function TabGroup({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: string[];
  activeTab: number;
  onTabChange: (index: number) => void;
}) {
  return (
    <div className="mb-6 flex gap-6 border-b border-border">
      {tabs.map((tab, index) => (
        <button
          key={tab}
          onClick={() => onTabChange(index)}
          className={`cursor-pointer px-1 pb-3 font-mono text-sm transition-colors ${
            activeTab === index
              ? 'border-b-2 border-[#00ff00] text-[#00ff00] drop-shadow-[0_0_8px_rgba(0,255,0,0.5)]'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          [{tab}]
        </button>
      ))}
    </div>
  );
}

function TeachableCard({
  funcName,
  category,
  description,
  example,
}: {
  funcName: string;
  category: string;
  description: string;
  example: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 transition-all hover:border-[#00ff00]/30">
      <div className="mb-3 flex items-start justify-between">
        <span className="font-mono text-lg text-purple-400 drop-shadow-[0_0_6px_rgba(167,139,250,0.3)]">
          {funcName}
        </span>
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground/50">
          [{category}]
        </span>
      </div>
      <div className="my-3 border-t border-border" />
      <p className="mb-4 text-muted-foreground">{description}</p>
      <code className="block rounded bg-muted p-3 font-mono text-sm text-foreground">
        {example}
      </code>
    </div>
  );
}

function ScrollReveal({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setIsVisible(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`transition-all duration-500 ${
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
      }`}
    >
      {children}
    </div>
  );
}

function SectionDivider() {
  return (
    <div className="py-8 text-center font-mono text-muted-foreground/30">
      ════════════════════════════════════════════════════════════
    </div>
  );
}

// ===== Section Components =====

function HeroSection() {
  const [queryDone, setQueryDone] = useState(false);

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 py-20">
      {/* Glow effect - green tint */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(0,255,0,0.08)_0%,transparent_70%)]" />

      <div className="relative z-10 mb-12 text-center">
        <h1 className="mb-6 text-4xl font-bold leading-tight md:text-6xl">
          <span className="bg-gradient-to-r from-[#00ff00] to-purple-400 bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(0,255,0,0.3)]">
            Ask Questions. Get Queries.
          </span>
        </h1>
        <p className="mx-auto max-w-2xl font-mono text-xl text-muted-foreground">
          {'>'} AI-powered SQL generation that learns your business_
        </p>
      </div>

      {/* Terminal Demo */}
      <div className="relative z-10 mb-12 w-full max-w-3xl">
        <TerminalWindow>
          {/* Previous commands (grayed) */}
          <div className="mb-2 text-muted-foreground/40">
            <span className="text-[#00ff00]/40">❯</span> SELECT * FROM users LIMIT 5;
          </div>
          <div className="mb-4 text-muted-foreground/40">
            <span className="text-[#00ff00]/40">❯</span> DESCRIBE orders;
          </div>
          {/* Current command with typing */}
          <div className="mb-4">
            <span className="text-[#00ff00] drop-shadow-[0_0_8px_rgba(0,255,0,0.5)]">
              ❯{' '}
            </span>
            <TypingText
              text="Show me top customers by revenue last quarter"
              speed={40}
              onComplete={() => setQueryDone(true)}
            />
          </div>
          {/* SQL output with line-by-line reveal */}
          {queryDone && (
            <div className="mt-6 border-t border-border/30 pt-4 text-foreground">
              <SQLReveal delay={200}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    SELECT
                  </span>{' '}
                  customer_id, <span className="text-purple-400">SUM</span>
                  (amount) <span className="text-[#00ff00]">as</span> revenue
                </div>
              </SQLReveal>
              <SQLReveal delay={400}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    FROM
                  </span>{' '}
                  orders
                </div>
              </SQLReveal>
              <SQLReveal delay={600}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    WHERE
                  </span>{' '}
                  created_at {'>'} ={' '}
                  <span className="text-lime-300">'2024-01-01'</span>
                </div>
              </SQLReveal>
              <SQLReveal delay={800}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    GROUP BY
                  </span>{' '}
                  customer_id
                </div>
              </SQLReveal>
              <SQLReveal delay={1000}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    ORDER BY
                  </span>{' '}
                  revenue{' '}
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    DESC
                  </span>
                </div>
              </SQLReveal>
              <SQLReveal delay={1200}>
                <div>
                  <span className="text-[#00ff00] drop-shadow-[0_0_6px_rgba(0,255,0,0.4)]">
                    LIMIT
                  </span>{' '}
                  <span className="text-orange-400">10</span>;
                </div>
              </SQLReveal>
            </div>
          )}
        </TerminalWindow>
      </div>

      {/* CTAs */}
      <div className="relative z-10 flex flex-col gap-4 sm:flex-row">
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-6 py-3 transition-all hover:border-[#00ff00]/50">
          <code className="font-mono text-foreground">
            $ npm i @deepagents/text2sql
          </code>
          <CopyButton text="npm i @deepagents/text2sql" />
        </div>
        <a
          href="https://github.com/JanuaryLabs/deepagents"
          className="rounded-md border border-border bg-transparent px-6 py-3 text-center font-mono text-foreground transition-colors hover:border-[#00ff00] hover:text-[#00ff00] hover:drop-shadow-[0_0_8px_rgba(0,255,0,0.3)]"
        >
          [GitHub] →
        </a>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-pulse font-mono text-[#00ff00]/50">
        ↓ SCROLL ↓
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const steps = [
    {
      number: '01',
      title: 'Connect Your Database',
      description:
        'Point Text2SQL at your database. Works with SQLite, PostgreSQL, and SQL Server out of the box. Schema introspection is automatic.',
    },
    {
      number: '02',
      title: 'Teach Domain Knowledge',
      description:
        'Define your business vocabulary, rules, and metrics using teachables. The AI learns what "revenue" means in YOUR context.',
    },
    {
      number: '03',
      title: 'Ask in Plain English',
      description:
        'Ask business questions naturally. Get accurate, executable SQL that respects your domain rules and coding standards.',
    },
  ];

  return (
    <section className="px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <h2 className="mb-16 text-center font-mono text-3xl font-bold text-foreground md:text-4xl">
            {'>'} HOW_IT_WORKS
          </h2>
        </ScrollReveal>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {steps.map((step, index) => (
            <ScrollReveal key={step.number} delay={index * 150}>
              <div className="text-center">
                <div className="mb-4 font-mono text-5xl font-bold text-[#00ff00] drop-shadow-[0_0_20px_rgba(0,255,0,0.4)]">
                  {step.number}
                </div>
                <h3 className="mb-4 text-xl font-bold text-foreground md:text-2xl">
                  {step.title}
                </h3>
                <p className="text-muted-foreground">{step.description}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    {
      icon: '┌─ >_ ─┐',
      title: 'Natural Language → SQL',
      description:
        'Ask questions in plain English. Get accurate, executable queries. No more context-switching between business requirements and SQL syntax.',
    },
    {
      icon: '╔═ {} ═╗',
      title: 'Deep Schema Understanding',
      description:
        'Auto-introspects tables, relationships, indexes, and column cardinality. Understands your data structure before generating queries.',
    },
    {
      icon: '┏━ λ ━┓',
      title: 'Teachable System',
      description:
        '17 ways to encode domain knowledge: terms, rules, workflows, guardrails. Your AI learns what matters to YOUR business.',
    },
    {
      icon: '╭─ ⟳ ─╮',
      title: 'User Memory',
      description:
        'Remembers preferences, learns from corrections, personalizes responses. The more you use it, the smarter it gets.',
    },
    {
      icon: '◇──◇──◇',
      title: 'Multi-Database Support',
      description:
        'SQLite, PostgreSQL, SQL Server. Extensible adapter pattern lets you add any database with a simple interface.',
    },
    {
      icon: '┌─ ✓ ─┐',
      title: 'Production Ready',
      description:
        'Query validation, error handling, streaming, and chat history built in. Not a prototype—ready for real workloads.',
    },
  ];

  return (
    <section className="bg-card px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <h2 className="mb-16 text-center font-mono text-3xl font-bold text-foreground md:text-4xl">
            {'>'} FEATURES
          </h2>
        </ScrollReveal>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature, index) => (
            <ScrollReveal key={feature.title} delay={index * 100}>
              <FeatureCard {...feature} />
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodeExamplesSection() {
  const [activeTab, setActiveTab] = useState(0);

  const tabs = ['Quick Start', 'Domain Knowledge', 'Chat Mode'];

  const quickStartCode = `import { Text2Sql, Sqlite } from '@deepagents/text2sql';

const adapter = new Sqlite({
  execute: (sql) => db.prepare(sql).all()
});

const text2sql = new Text2Sql({ adapter });

// Generate SQL from natural language
const sql = await text2sql
  .toSql("Show top 10 customers by revenue")
  .generate();`;

  const domainKnowledgeCode = `import { term, glossary, hint, guardrail } from '@deepagents/text2sql';

// Teach business vocabulary
text2sql.instruct(
  term("ARR", "Annual Recurring Revenue"),
  term("churn", "customers who cancelled in the period"),

  // Map business terms to SQL expressions
  glossary({
    "revenue": "SUM(orders.amount)",
    "active user": "last_login > NOW() - INTERVAL '30 days'"
  }),

  // Add behavioral rules
  hint("Always exclude test accounts from metrics"),
  guardrail({ rule: "Never return PII in results" })
);`;

  const chatModeCode = `// Multi-turn conversation with memory
const stream = await text2sql.chat(
  [{ role: 'user', content: 'What products are trending this week?' }],
  { userId: 'analyst-42', chatId: 'session-001' }
);

for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// System remembers context for follow-up questions
// "Break that down by region" - knows you mean trending products`;

  const codeExamples = [quickStartCode, domainKnowledgeCode, chatModeCode];
  const filenames = ['quick-start.ts', 'domain-knowledge.ts', 'chat-mode.ts'];

  return (
    <section className="px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <ScrollReveal>
          <h2 className="mb-16 text-center font-mono text-3xl font-bold text-foreground md:text-4xl">
            {'>'} CODE_EXAMPLES
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <TabGroup tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          <CodeBlock filename={filenames[activeTab]} code={codeExamples[activeTab]}>
            {activeTab === 0 && (
              <>
                <span className="text-[#00ff00]">import</span> {'{'} Text2Sql, Sqlite
                {'}'} <span className="text-[#00ff00]">from</span>{' '}
                <span className="text-lime-300">'@deepagents/text2sql'</span>;
                {'\n\n'}
                <span className="text-[#00ff00]">const</span> adapter ={' '}
                <span className="text-[#00ff00]">new</span>{' '}
                <span className="text-purple-400">Sqlite</span>({'{'}
                {'\n'}  execute: (sql) {'=>'} db.
                <span className="text-purple-400">prepare</span>(sql).
                <span className="text-purple-400">all</span>()
                {'\n'}
                {'}'});
                {'\n\n'}
                <span className="text-[#00ff00]">const</span> text2sql ={' '}
                <span className="text-[#00ff00]">new</span>{' '}
                <span className="text-purple-400">Text2Sql</span>({'{'} adapter {'}'});
                {'\n\n'}
                <span className="italic text-muted-foreground">
                  // Generate SQL from natural language
                </span>
                {'\n'}
                <span className="text-[#00ff00]">const</span> sql ={' '}
                <span className="text-[#00ff00]">await</span> text2sql
                {'\n'}  .<span className="text-purple-400">toSql</span>(
                <span className="text-lime-300">"Show top 10 customers by revenue"</span>
                ){'\n'}  .<span className="text-purple-400">generate</span>();
              </>
            )}
            {activeTab === 1 && (
              <>
                <span className="text-[#00ff00]">import</span> {'{'} term, glossary,
                hint, guardrail {'}'} <span className="text-[#00ff00]">from</span>{' '}
                <span className="text-lime-300">'@deepagents/text2sql'</span>;
                {'\n\n'}
                <span className="italic text-muted-foreground">
                  // Teach business vocabulary
                </span>
                {'\n'}
                text2sql.<span className="text-purple-400">instruct</span>(
                {'\n'}  <span className="text-purple-400">term</span>(
                <span className="text-lime-300">"ARR"</span>,{' '}
                <span className="text-lime-300">"Annual Recurring Revenue"</span>
                ),
                {'\n'}  <span className="text-purple-400">term</span>(
                <span className="text-lime-300">"churn"</span>,{' '}
                <span className="text-lime-300">
                  "customers who cancelled in the period"
                </span>
                ),
                {'\n\n'}  <span className="italic text-muted-foreground">
                  // Map business terms to SQL expressions
                </span>
                {'\n'}  <span className="text-purple-400">glossary</span>({'{'}
                {'\n'}    <span className="text-lime-300">"revenue"</span>:{' '}
                <span className="text-lime-300">"SUM(orders.amount)"</span>,
                {'\n'}    <span className="text-lime-300">"active user"</span>:{' '}
                <span className="text-lime-300">
                  "last_login {'>'} NOW() - INTERVAL '30 days'"
                </span>
                {'\n'}  {'}'}),
                {'\n\n'}  <span className="italic text-muted-foreground">
                  // Add behavioral rules
                </span>
                {'\n'}  <span className="text-purple-400">hint</span>(
                <span className="text-lime-300">
                  "Always exclude test accounts from metrics"
                </span>
                ),
                {'\n'}  <span className="text-purple-400">guardrail</span>({'{'} rule:{' '}
                <span className="text-lime-300">"Never return PII in results"</span>{' '}
                {'}'}){'\n'});
              </>
            )}
            {activeTab === 2 && (
              <>
                <span className="italic text-muted-foreground">
                  // Multi-turn conversation with memory
                </span>
                {'\n'}
                <span className="text-[#00ff00]">const</span> stream ={' '}
                <span className="text-[#00ff00]">await</span> text2sql.
                <span className="text-purple-400">chat</span>({'\n'}  [{'{'} role:{' '}
                <span className="text-lime-300">'user'</span>, content:{' '}
                <span className="text-lime-300">
                  'What products are trending this week?'
                </span>{' '}
                {'}'}],
                {'\n'}  {'{'} userId:{' '}
                <span className="text-lime-300">'analyst-42'</span>, chatId:{' '}
                <span className="text-lime-300">'session-001'</span> {'}'}
                {'\n'});
                {'\n\n'}
                <span className="text-[#00ff00]">for await</span> (
                <span className="text-[#00ff00]">const</span> chunk{' '}
                <span className="text-[#00ff00]">of</span> stream) {'{'}
                {'\n'}  process.stdout.
                <span className="text-purple-400">write</span>(chunk);
                {'\n'}
                {'}'}
                {'\n\n'}
                <span className="italic text-muted-foreground">
                  // System remembers context for follow-up questions
                </span>
                {'\n'}
                <span className="italic text-muted-foreground">
                  // "Break that down by region" - knows you mean trending products
                </span>
              </>
            )}
          </CodeBlock>
        </ScrollReveal>
      </div>
    </section>
  );
}

function TeachablesSection() {
  const [activeTab, setActiveTab] = useState(0);

  const domainTeachables = [
    {
      funcName: 'term()',
      category: 'VOCABULARY',
      description:
        'Define business vocabulary and acronyms that only your organization uses.',
      example: 'term("NPL", "non-performing loan - past due 90+ days")',
    },
    {
      funcName: 'guardrail()',
      category: 'COMPLIANCE',
      description: 'Set hard boundaries the AI must never cross.',
      example:
        'guardrail({ rule: "Never return SSN or MRN in results", reason: "HIPAA compliance" })',
    },
    {
      funcName: 'glossary()',
      category: 'MAPPING',
      description: 'Map business terms directly to SQL expressions.',
      example: 'glossary({ "revenue": "SUM(orders.amount)" })',
    },
    {
      funcName: 'hint()',
      category: 'BEHAVIOR',
      description: 'Add behavioral rules that guide query generation.',
      example: 'hint("Always exclude deleted records unless specifically asked")',
    },
  ];

  const userTeachables = [
    {
      funcName: 'identity()',
      category: 'PROFILE',
      description: 'Define user profile and role for personalized responses.',
      example: 'identity({ role: "analyst", department: "finance" })',
    },
    {
      funcName: 'alias()',
      category: 'TERMINOLOGY',
      description: 'User-specific terminology and shortcuts.',
      example: 'alias("my tables", ["orders", "customers", "products"])',
    },
    {
      funcName: 'preference()',
      category: 'OUTPUT',
      description: 'Output formatting preferences.',
      example: 'preference({ dateFormat: "YYYY-MM-DD", limit: 100 })',
    },
    {
      funcName: 'correction()',
      category: 'LEARNING',
      description: 'Learn from user corrections to improve future queries.',
      example: 'correction({ wrong: "users", right: "customers" })',
    },
  ];

  const teachables = activeTab === 0 ? domainTeachables : userTeachables;

  return (
    <section className="bg-card px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <ScrollReveal>
          <h2 className="mb-4 text-center font-mono text-3xl font-bold text-foreground md:text-4xl">
            {'>'} TEACHABLES
          </h2>
          <p className="mb-12 text-center font-mono text-muted-foreground">
            // 17 ways to encode domain expertise
          </p>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <TabGroup
            tabs={['Domain Knowledge', 'User Personalization']}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {teachables.map((teachable, index) => (
              <ScrollReveal key={teachable.funcName} delay={index * 75}>
                <TeachableCard {...teachable} />
              </ScrollReveal>
            ))}
          </div>

          <div className="mt-8 text-center">
            <a
              href="/docs/text2sql"
              className="font-mono text-[#00ff00] transition-all hover:drop-shadow-[0_0_8px_rgba(0,255,0,0.5)] hover:underline"
            >
              [VIEW ALL 17] →
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

function StatsSection() {
  const stats = [
    { value: '17', label: 'Teachable Types' },
    { value: '3', label: 'Databases Supported' },
    { value: '∞', label: 'Queries Generated' },
  ];

  return (
    <section className="px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-4xl">
        <ScrollReveal>
          <div className="grid grid-cols-3 gap-8 text-center">
            {stats.map((stat) => (
              <div key={stat.label}>
                <div className="mb-2 font-mono text-5xl font-bold text-[#00ff00] drop-shadow-[0_0_20px_rgba(0,255,0,0.4)] md:text-6xl">
                  <AnimatedCounter target={stat.value} />
                </div>
                <div className="font-mono text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="bg-card px-6 py-24">
      <SectionDivider />
      <div className="mx-auto max-w-2xl text-center">
        <ScrollReveal>
          <h2 className="mb-8 font-mono text-3xl font-bold text-foreground md:text-4xl">
            {'>'} READY_TO_START?
          </h2>

          <div className="mb-8 flex items-center justify-between gap-4 rounded-lg border border-border bg-muted p-4 transition-all hover:border-[#00ff00]/50">
            <code className="font-mono text-foreground">
              $ npm install @deepagents/text2sql
            </code>
            <CopyButton text="npm install @deepagents/text2sql" />
          </div>

          <div className="flex justify-center gap-6 font-mono">
            <a
              href="/docs/text2sql"
              className="text-muted-foreground transition-colors hover:text-[#00ff00] hover:drop-shadow-[0_0_8px_rgba(0,255,0,0.3)]"
            >
              [DOCS]
            </a>
            <a
              href="https://github.com/JanuaryLabs/deepagents"
              className="text-muted-foreground transition-colors hover:text-[#00ff00] hover:drop-shadow-[0_0_8px_rgba(0,255,0,0.3)]"
            >
              [GITHUB]
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border px-6 py-12">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-lg border border-border bg-muted p-6 font-mono text-sm">
          <div className="mb-2 text-muted-foreground">
            $ npm info @deepagents/text2sql
          </div>
          <div className="mb-4 text-foreground">
            @deepagents/text2sql@1.0.0 | MIT | deps: 2 | versions: 1
          </div>
          <div className="flex flex-wrap justify-center gap-4 text-muted-foreground">
            <a
              href="https://github.com/JanuaryLabs/deepagents"
              className="hover:text-[#00ff00]"
            >
              [GitHub]
            </a>
            <span>·</span>
            <a
              href="https://www.npmjs.com/package/@deepagents/text2sql"
              className="hover:text-[#00ff00]"
            >
              [npm]
            </a>
            <span>·</span>
            <a href="/docs/text2sql" className="hover:text-[#00ff00]">
              [Docs]
            </a>
          </div>
          <div className="mt-4 text-center text-muted-foreground/50">
            MIT License · © 2024 JanuaryLabs
          </div>
        </div>
      </div>
    </footer>
  );
}

// ===== Main App Component =====

export function App() {
  return (
    <div className="min-h-screen bg-background font-mono">
      <HeroSection />
      <HowItWorksSection />
      <FeaturesSection />
      <CodeExamplesSection />
      <TeachablesSection />
      <StatsSection />
      <CTASection />
      <Footer />
    </div>
  );
}

export default App;
