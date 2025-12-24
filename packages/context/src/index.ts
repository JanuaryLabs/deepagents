import type { ContextFragment } from './lib/context.ts';
import { type ContextRenderer } from './lib/renderers/abstract.renderer.ts';

export type { ContextFragment } from './lib/context.ts';
export {
  type ContextRenderer,
  type RendererOptions,
  XmlRenderer,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
} from './lib/renderers/abstract.renderer.ts';

export class ContextEngine {
  #fragments: ContextFragment[] = [];

  public set(...fragments: ContextFragment[]) {
    this.#fragments.push(...fragments);
  }
  public render(renderer: ContextRenderer) {
    return renderer.render(this.#fragments);
  }
}

export function hint(text: string): ContextFragment {
  return {
    name: 'hint',
    data: text,
  };
}

export function fragment(
  name: string,
  ...children: ContextFragment[]
): ContextFragment {
  return {
    name,
    data: children,
  };
}
