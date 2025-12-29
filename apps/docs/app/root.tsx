import { RootProvider } from 'fumadocs-ui/provider/react-router';
import {
  Links,
  type LinksFunction,
  Meta,
  type MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';

import '../styles.css';

export const meta: MetaFunction = () => [
  { title: 'Text2SQL - Natural Language to SQL | DeepAgents' },
  { name: 'description', content: 'AI-powered SQL generation that learns your business. Convert natural language questions to accurate SQL queries with domain knowledge.' },
  { property: 'og:title', content: 'Text2SQL - Ask Questions. Get Queries.' },
  { property: 'og:description', content: 'AI-powered SQL generation with teachables for domain knowledge' },
  { name: 'twitter:card', content: 'summary_large_image' },
];

export const links: LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700;9..144,900&display=swap',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap',
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <RootProvider
          search={{
            options: {
              type: 'static',
              api: '/deepagents/api/search',
            },
          }}
        >
          {children}
        </RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
