import type * as PageTree from 'fumadocs-core/page-tree';
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
    tree: source.getPageTree(),
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

function DocsContent({ path }: { path: string }) {
  const Content = clientLoader.getComponent(path);
  return <Content />;
}

export default function Page({ loaderData }: Route.ComponentProps) {
  const { tree, path } = loaderData;

  return (
    <DocsLayout {...baseOptions()} tree={tree as PageTree.Root} tabMode="top">
      <DocsContent path={path} />
    </DocsLayout>
  );
}
