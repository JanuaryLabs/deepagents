import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Link } from 'react-router';

const packages = [
  {
    name: '@deepagents/agent',
    description:
      'Core agent framework with tool orchestration and multi-provider support.',
    href: '/docs/agent',
  },
  {
    name: '@deepagents/text2sql',
    description:
      'Natural language to SQL with domain learning and teachable context.',
    href: '/docs/text2sql',
  },
  {
    name: '@deepagents/context',
    description: 'Context management with tokenization and persistence layer.',
    href: '/docs/context',
  },
  {
    name: '@deepagents/retrieval',
    description:
      'Vector & semantic retrieval with embeddings and full-text search.',
    href: '/docs/retrieval',
  },
  {
    name: '@deepagents/orchestrator',
    description: 'Multi-agent workflow coordination and task distribution.',
    href: '/docs/orchestrator',
  },
  {
    name: '@deepagents/toolbox',
    description: 'Common utilities: web search, shell execution, and helpers.',
    href: '/docs/toolbox',
  },
];

const features = [
  {
    number: '01',
    title: 'Production-Ready',
    description:
      'Built for real workloads with proper error handling, retries, and observability.',
  },
  {
    number: '02',
    title: 'Composable',
    description:
      'Mix and match packages. Use only what you need. No monolithic frameworks.',
  },
  {
    number: '03',
    title: 'Battery Powered',
    description:
      'Built-in retrieval, embeddings, connectors, and tools. Everything you need out of the box.',
  },
];

const codeExamples = {
  agent: `import { agent, execute } from '@deepagents/agent';
import { groq } from '@ai-sdk/groq';

const assistant = agent({
  name: 'Assistant',
  model: groq('gpt-oss-20b'),
  prompt: 'You are a helpful assistant.',
});

await execute(assistant, 'Hello!', {});`,

  text2sql: `import { Text2Sql, InMemoryHistory } from '@deepagents/text2sql';
import { Postgres } from '@deepagents/text2sql/postgres';

const text2sql = new Text2Sql({
  version: 'v1',
  adapter: new Postgres({ execute, grounding: [] }),
  history: new InMemoryHistory(),
});

await text2sql.toSql('Show all customers');`,

  context: `import { ContextEngine, role, user, XmlRenderer } from '@deepagents/context';
import { SqliteContextStore } from '@deepagents/context';

const context = new ContextEngine({
  store: new SqliteContextStore('./chat.db'),
  chatId: 'session-1',
  userId: 'user-1',
});

context.set(role('You are helpful'), user('Hello'));
await context.resolve({ renderer: new XmlRenderer() });`,

  retrieval: `import { ingest, fastembed, nodeSQLite } from '@deepagents/retrieval';
import * as connectors from '@deepagents/retrieval/connectors';

await ingest({
  connector: connectors.local('./docs'),
  store: nodeSQLite('./vectors.db', 1024),
  embedder: fastembed(),
});`,
};

function PackageCard({
  name,
  description,
  href,
}: {
  name: string;
  description: string;
  href: string;
}) {
  return (
    <Link to={href} className="package-card block">
      <div className="package-card-title">{name}</div>
      <div className="package-card-desc">{description}</div>
      <div className="package-card-arrow">--&gt;</div>
    </Link>
  );
}

function FeatureBlock({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="feature-number">{number}</div>
      <div className="feature-title">{title}</div>
      <div className="feature-desc">{description}</div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="brutalist-page">
      {/* Grain overlay */}
      <div className="grain" />

      {/* Hero Section */}
      <section
        style={{
          paddingTop: '6rem',
          paddingBottom: '4rem',
        }}
      >
        <div className="container-narrow">
          {/* Terminal with install commands */}
          <div style={{ maxWidth: '600px', marginBottom: '3rem' }}>
            <DynamicCodeBlock
              lang="bash"
              code={`npm install @deepagents/agent
npm install @deepagents/text2sql
npm install @deepagents/context`}
            />
          </div>

          {/* Package Usage Examples */}
          <div style={{ maxWidth: '700px', marginBottom: '3rem' }}>
            <Tabs items={['agent', 'text2sql', 'context', 'retrieval']}>
              <Tab value="agent">
                <DynamicCodeBlock lang="ts" code={codeExamples.agent} />
              </Tab>
              <Tab value="text2sql">
                <DynamicCodeBlock lang="ts" code={codeExamples.text2sql} />
              </Tab>
              <Tab value="context">
                <DynamicCodeBlock lang="ts" code={codeExamples.context} />
              </Tab>
              <Tab value="retrieval">
                <DynamicCodeBlock lang="ts" code={codeExamples.retrieval} />
              </Tab>
            </Tabs>
          </div>

          {/* Hero content */}
          <div style={{ maxWidth: '800px' }}>
            <h1 className="hero-title" style={{ marginBottom: '1.5rem' }}>
              DEEP
              <br />
              AGENTS
            </h1>
            <p
              className="text-fd-muted-foreground font-sans text-xl leading-relaxed max-w-[540px] mb-10"
            >
              AI-native building blocks for production systems. Composable
              packages for agents, retrieval, and natural language interfaces.
            </p>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <Link to="/docs/agent" className="btn btn-primary">
                Get Started
              </Link>
              <a
                href="https://github.com/JanuaryLabs/deepagents"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
              >
                View Source
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Packages Section */}
      <section style={{ paddingTop: '4rem', paddingBottom: '4rem' }}>
        <div className="container-narrow">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: '2.5rem',
            }}
          >
            <h2 className="section-title">PACKAGES</h2>
            <span className="outline-text" aria-hidden="true">
              01
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: '1rem',
            }}
          >
            {packages.map((pkg) => (
              <PackageCard key={pkg.name} {...pkg} />
            ))}
          </div>
        </div>
      </section>

      <div className="container-narrow">
        <div className="section-divider" />
      </div>

      {/* Why Section */}
      <section style={{ paddingTop: '4rem', paddingBottom: '4rem' }}>
        <div className="container-narrow">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: '2.5rem',
            }}
          >
            <h2 className="section-title">WHY DEEP AGENTS</h2>
            <span className="outline-text" aria-hidden="true">
              02
            </span>
          </div>

          {/* Features terminal mockup */}
          <div style={{ marginBottom: '3rem', maxWidth: '700px' }}>
            <DynamicCodeBlock
              lang="ts"
              code={`const features = {
  production: "Built for real workloads",
  composable: "Use only what you need",
  batteryPowered: "Built-in retrieval, text2sql, and tools",
};`}
            />
          </div>

          {/* Feature blocks */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '2.5rem',
            }}
          >
            {features.map((feature) => (
              <FeatureBlock key={feature.number} {...feature} />
            ))}
          </div>
        </div>
      </section>

      <div className="container-narrow">
        <div className="section-divider" />
      </div>

      {/* Quick Start Section */}
      <section style={{ paddingTop: '4rem', paddingBottom: '4rem' }}>
        <div className="container-narrow">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: '2.5rem',
            }}
          >
            <h2 className="section-title">QUICK START</h2>
            <span className="outline-text" aria-hidden="true">
              03
            </span>
          </div>

          <div style={{ maxWidth: '700px' }}>
            <DynamicCodeBlock
              lang="ts"
              code={`import { agent, execute } from '@deepagents/agent';
import { similaritySearch, nodeSQLite, fastembed } from '@deepagents/retrieval';
import * as connectors from '@deepagents/retrieval/connectors';
import { groq } from '@ai-sdk/groq';

const results = await similaritySearch(query, {
  store: nodeSQLite('./knowledge.sqlite', 1024),
  embedder: fastembed(),
  connector: connectors.github.repo(
    'https://github.com/JanuaryLabs/deepagents',
    { includes: ['docs/**/*.md'] }
  ),
});

const assistant = agent({
  name: 'Assistant',
  model: groq('gpt-oss-20b'),
  prompt: results.map(r => r.content).join('\\n'),
});

await execute(assistant, "What can DeepAgents do?");`}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="container-narrow">
          MIT LICENSE &bull; JANUARYLABS &bull; 2025
        </div>
      </footer>
    </div>
  );
}
