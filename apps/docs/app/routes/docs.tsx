import { useFumadocsLoader } from 'fumadocs-core/source/client';
import browserCollections from 'fumadocs-mdx:collections/browser';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
// import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/page';
import type { Route } from '~routes/routes/+types/docs.ts';

import { baseOptions } from '../layout.shared.tsx';
import { source } from '../source.ts';

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params['*']?.split('/').filter((v) => v.length > 0);
  const page = source.getPage(slugs);
  if (!page) throw new Response('Not found', { status: 404 });

  return {
    path: page.path,
    tree: await source.serializePageTree(source.getPageTree()),
  };
}

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, default: Mdx, frontmatter }) {
    return (
      <DocsPage toc={toc}>
        <title>{frontmatter.title}</title>
        <meta name="description" content={frontmatter.description} />
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <Mdx components={{ ...defaultMdxComponents, Tab, Tabs }} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export default function Page({ loaderData }: Route.ComponentProps) {
  const { tree, path } = useFumadocsLoader(loaderData);
  const content = clientLoader.useContent(path);

  return (
    <DocsLayout {...baseOptions()} tree={tree} tabMode="top">
      {content}
    </DocsLayout>
  );
}
