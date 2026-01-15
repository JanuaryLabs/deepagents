import pluralize from 'pluralize';
import { titlecase } from 'stringcase';

import {
  type ContextFragment,
  type FragmentData,
  type FragmentObject,
  isFragment,
  isFragmentObject,
} from '../fragments.ts';

/**
 * Render context passed through the template method.
 */
export interface RenderContext {
  depth: number;
  path: string[];
}

/**
 * Options for renderers.
 */
export interface RendererOptions {
  /**
   * When true, fragments with the same name are grouped under a pluralized parent tag.
   * e.g., multiple <hint> become <hints><hint>...</hint><hint>...</hint></hints>
   */
  groupFragments?: boolean;
}

/**
 * Base renderer implementing the Template Method pattern.
 * Subclasses implement the specific formatting hooks.
 */
export abstract class ContextRenderer {
  protected options: RendererOptions;

  constructor(options: RendererOptions = {}) {
    this.options = options;
  }

  abstract render(fragments: ContextFragment[]): string;

  /**
   * Check if data is a primitive (string, number, boolean).
   */
  protected isPrimitive(data: FragmentData): data is string | number | boolean {
    return (
      typeof data === 'string' ||
      typeof data === 'number' ||
      typeof data === 'boolean'
    );
  }

  /**
   * Group fragments by name for groupFragments option.
   */
  protected groupByName(
    fragments: ContextFragment[],
  ): Map<string, ContextFragment[]> {
    const groups = new Map<string, ContextFragment[]>();
    for (const fragment of fragments) {
      const existing = groups.get(fragment.name) ?? [];
      existing.push(fragment);
      groups.set(fragment.name, existing);
    }
    return groups;
  }

  /**
   * Remove null/undefined from fragments and fragment data recursively.
   * This protects renderers from nullish values and ensures they are ignored
   * consistently across all output formats.
   */
  protected sanitizeFragments(fragments: ContextFragment[]): ContextFragment[] {
    const sanitized: ContextFragment[] = [];
    for (const fragment of fragments) {
      const cleaned = this.sanitizeFragment(fragment, new WeakSet<object>());
      if (cleaned) {
        sanitized.push(cleaned);
      }
    }
    return sanitized;
  }

  protected sanitizeFragment(
    fragment: ContextFragment,
    seen: WeakSet<object>,
  ): ContextFragment | null {
    const data = this.sanitizeData(fragment.data, seen);
    if (data == null) {
      return null;
    }
    return {
      ...fragment,
      data,
    };
  }

  protected sanitizeData(
    data: FragmentData,
    seen: WeakSet<object>,
  ): FragmentData | undefined {
    if (data == null) {
      return undefined;
    }

    if (isFragment(data)) {
      return this.sanitizeFragment(data, seen) ?? undefined;
    }

    if (Array.isArray(data)) {
      if (seen.has(data)) {
        return undefined;
      }
      seen.add(data);

      const cleaned: FragmentData[] = [];
      for (const item of data) {
        const sanitizedItem = this.sanitizeData(item, seen);
        if (sanitizedItem != null) {
          cleaned.push(sanitizedItem);
        }
      }
      return cleaned;
    }

    if (isFragmentObject(data)) {
      if (seen.has(data)) {
        return undefined;
      }
      seen.add(data);

      const cleaned: FragmentObject = {};
      for (const [key, value] of Object.entries(data)) {
        const sanitizedValue = this.sanitizeData(value, seen);
        if (sanitizedValue != null) {
          cleaned[key] = sanitizedValue;
        }
      }
      return cleaned;
    }

    return data;
  }

  /**
   * Template method - dispatches value to appropriate handler.
   */
  protected renderValue(
    key: string,
    value: unknown,
    ctx: RenderContext,
  ): string {
    if (value == null) {
      return '';
    }
    if (isFragment(value)) {
      return this.renderFragment(value, ctx);
    }
    if (Array.isArray(value)) {
      return this.renderArray(key, value, ctx);
    }
    if (isFragmentObject(value)) {
      return this.renderObject(key, value, ctx);
    }
    return this.renderPrimitive(key, String(value), ctx);
  }

  /**
   * Render a nested fragment - subclasses implement this.
   */
  protected abstract renderFragment(
    fragment: ContextFragment,
    ctx: RenderContext,
  ): string;

  /**
   * Render all entries of an object.
   */
  protected renderEntries(data: FragmentObject, ctx: RenderContext): string[] {
    return Object.entries(data)
      .map(([key, value]) => this.renderValue(key, value, ctx))
      .filter(Boolean);
  }

  // Hooks - subclasses implement these
  protected abstract renderPrimitive(
    key: string,
    value: string,
    ctx: RenderContext,
  ): string;
  protected abstract renderArray(
    key: string,
    items: FragmentData[],
    ctx: RenderContext,
  ): string;
  protected abstract renderObject(
    key: string,
    obj: FragmentObject,
    ctx: RenderContext,
  ): string;
}

/**
 * Renders context fragments as XML.
 */
export class XmlRenderer extends ContextRenderer {
  render(fragments: ContextFragment[]): string {
    const sanitized = this.sanitizeFragments(fragments);
    return sanitized
      .map((f) => this.#renderTopLevel(f))
      .filter(Boolean)
      .join('\n');
  }

  #renderTopLevel(fragment: ContextFragment): string {
    if (this.isPrimitive(fragment.data)) {
      return this.#leafRoot(fragment.name, String(fragment.data));
    }
    if (Array.isArray(fragment.data)) {
      return this.#renderArray(fragment.name, fragment.data, 0);
    }
    if (isFragment(fragment.data)) {
      const child = this.renderFragment(fragment.data, { depth: 1, path: [] });
      return this.#wrap(fragment.name, [child]);
    }
    if (isFragmentObject(fragment.data)) {
      return this.#wrap(
        fragment.name,
        this.renderEntries(fragment.data, { depth: 1, path: [] }),
      );
    }
    return '';
  }

  #renderArray(name: string, items: FragmentData[], depth: number): string {
    const fragmentItems = items.filter(isFragment);
    const nonFragmentItems = items.filter((item) => !isFragment(item));

    const children: string[] = [];

    // Render non-fragment items
    for (const item of nonFragmentItems) {
      if (item != null) {
        children.push(
          this.#leaf(pluralize.singular(name), String(item), depth + 1),
        );
      }
    }

    // Render fragment items (possibly grouped)
    if (this.options.groupFragments && fragmentItems.length > 0) {
      const groups = this.groupByName(fragmentItems);
      for (const [groupName, groupFragments] of groups) {
        const groupChildren = groupFragments.map((frag) =>
          this.renderFragment(frag, { depth: depth + 2, path: [] }),
        );
        const pluralName = pluralize.plural(groupName);
        children.push(this.#wrapIndented(pluralName, groupChildren, depth + 1));
      }
    } else {
      for (const frag of fragmentItems) {
        children.push(
          this.renderFragment(frag, { depth: depth + 1, path: [] }),
        );
      }
    }

    return this.#wrap(name, children);
  }

  #leafRoot(tag: string, value: string): string {
    const safe = this.#escape(value);
    if (safe.includes('\n')) {
      return `<${tag}>\n${this.#indent(safe, 2)}\n</${tag}>`;
    }
    return `<${tag}>${safe}</${tag}>`;
  }

  protected renderFragment(
    fragment: ContextFragment,
    ctx: RenderContext,
  ): string {
    const { name, data } = fragment;
    if (this.isPrimitive(data)) {
      return this.#leaf(name, String(data), ctx.depth);
    }
    if (isFragment(data)) {
      const child = this.renderFragment(data, { ...ctx, depth: ctx.depth + 1 });
      return this.#wrapIndented(name, [child], ctx.depth);
    }
    if (Array.isArray(data)) {
      return this.#renderArrayIndented(name, data, ctx.depth);
    }
    if (isFragmentObject(data)) {
      const children = this.renderEntries(data, {
        ...ctx,
        depth: ctx.depth + 1,
      });
      return this.#wrapIndented(name, children, ctx.depth);
    }
    return '';
  }

  #renderArrayIndented(
    name: string,
    items: FragmentData[],
    depth: number,
  ): string {
    const fragmentItems = items.filter(isFragment);
    const nonFragmentItems = items.filter((item) => !isFragment(item));

    const children: string[] = [];

    // Render non-fragment items
    for (const item of nonFragmentItems) {
      if (item != null) {
        children.push(
          this.#leaf(pluralize.singular(name), String(item), depth + 1),
        );
      }
    }

    // Render fragment items (possibly grouped)
    if (this.options.groupFragments && fragmentItems.length > 0) {
      const groups = this.groupByName(fragmentItems);
      for (const [groupName, groupFragments] of groups) {
        const groupChildren = groupFragments.map((frag) =>
          this.renderFragment(frag, { depth: depth + 2, path: [] }),
        );
        const pluralName = pluralize.plural(groupName);
        children.push(this.#wrapIndented(pluralName, groupChildren, depth + 1));
      }
    } else {
      for (const frag of fragmentItems) {
        children.push(
          this.renderFragment(frag, { depth: depth + 1, path: [] }),
        );
      }
    }

    return this.#wrapIndented(name, children, depth);
  }

  protected renderPrimitive(
    key: string,
    value: string,
    ctx: RenderContext,
  ): string {
    return this.#leaf(key, value, ctx.depth);
  }

  protected renderArray(
    key: string,
    items: FragmentData[],
    ctx: RenderContext,
  ): string {
    if (!items.length) {
      return '';
    }
    const itemTag = pluralize.singular(key);
    const children = items
      .filter((item) => item != null)
      .map((item) => this.#leaf(itemTag, String(item), ctx.depth + 1));
    return this.#wrapIndented(key, children, ctx.depth);
  }

  protected renderObject(
    key: string,
    obj: FragmentObject,
    ctx: RenderContext,
  ): string {
    const children = this.renderEntries(obj, { ...ctx, depth: ctx.depth + 1 });
    return this.#wrapIndented(key, children, ctx.depth);
  }

  #escape(value: string): string {
    if (value == null) {
      return '';
    }
    return value
      .replaceAll(/&/g, '&amp;')
      .replaceAll(/</g, '&lt;')
      .replaceAll(/>/g, '&gt;')
      .replaceAll(/"/g, '&quot;')
      .replaceAll(/'/g, '&apos;');
  }

  #indent(text: string, spaces: number): string {
    if (!text.trim()) {
      return '';
    }
    const padding = ' '.repeat(spaces);
    return text
      .split('\n')
      .map((line) => (line.length ? padding + line : padding))
      .join('\n');
  }

  #leaf(tag: string, value: string, depth: number): string {
    const safe = this.#escape(value);
    const pad = '  '.repeat(depth);
    if (safe.includes('\n')) {
      return `${pad}<${tag}>\n${this.#indent(safe, (depth + 1) * 2)}\n${pad}</${tag}>`;
    }
    return `${pad}<${tag}>${safe}</${tag}>`;
  }

  #wrap(tag: string, children: string[]): string {
    const content = children.filter(Boolean).join('\n');
    if (!content) {
      return '';
    }
    return `<${tag}>\n${content}\n</${tag}>`;
  }

  #wrapIndented(tag: string, children: string[], depth: number): string {
    const content = children.filter(Boolean).join('\n');
    if (!content) {
      return '';
    }
    const pad = '  '.repeat(depth);
    return `${pad}<${tag}>\n${content}\n${pad}</${tag}>`;
  }
}

/**
 * Renders context fragments as Markdown.
 */
export class MarkdownRenderer extends ContextRenderer {
  render(fragments: ContextFragment[]): string {
    return this.sanitizeFragments(fragments)
      .map((f) => {
        const title = `## ${titlecase(f.name)}`;
        if (this.isPrimitive(f.data)) {
          return `${title}\n${String(f.data)}`;
        }
        if (Array.isArray(f.data)) {
          return `${title}\n${this.#renderArray(f.data, 0)}`;
        }
        if (isFragment(f.data)) {
          return `${title}\n${this.renderFragment(f.data, { depth: 0, path: [] })}`;
        }
        if (isFragmentObject(f.data)) {
          return `${title}\n${this.renderEntries(f.data, { depth: 0, path: [] }).join('\n')}`;
        }
        return `${title}\n`;
      })
      .join('\n\n');
  }

  #renderArray(items: FragmentData[], depth: number): string {
    const fragmentItems = items.filter(isFragment);
    const nonFragmentItems = items.filter((item) => !isFragment(item));

    const lines: string[] = [];

    // Render non-fragment items
    for (const item of nonFragmentItems) {
      if (item != null) {
        lines.push(`${this.#pad(depth)}- ${String(item)}`);
      }
    }

    // Render fragment items (possibly grouped)
    if (this.options.groupFragments && fragmentItems.length > 0) {
      const groups = this.groupByName(fragmentItems);
      for (const [groupName, groupFragments] of groups) {
        const pluralName = pluralize.plural(groupName);
        lines.push(`${this.#pad(depth)}- **${titlecase(pluralName)}**:`);
        for (const frag of groupFragments) {
          lines.push(this.renderFragment(frag, { depth: depth + 1, path: [] }));
        }
      }
    } else {
      for (const frag of fragmentItems) {
        lines.push(this.renderFragment(frag, { depth, path: [] }));
      }
    }

    return lines.join('\n');
  }

  #pad(depth: number): string {
    return '  '.repeat(depth);
  }

  #leaf(key: string, value: string, depth: number): string {
    return `${this.#pad(depth)}- **${key}**: ${value}`;
  }

  #arrayItem(item: unknown, depth: number): string {
    if (isFragment(item)) {
      return this.renderFragment(item, { depth, path: [] });
    }
    if (isFragmentObject(item)) {
      return this.renderEntries(item, {
        depth,
        path: [],
      }).join('\n');
    }
    return `${this.#pad(depth)}- ${String(item)}`;
  }

  protected renderFragment(
    fragment: ContextFragment,
    ctx: RenderContext,
  ): string {
    const { name, data } = fragment;
    const header = `${this.#pad(ctx.depth)}- **${name}**:`;
    if (this.isPrimitive(data)) {
      return `${this.#pad(ctx.depth)}- **${name}**: ${String(data)}`;
    }
    if (isFragment(data)) {
      const child = this.renderFragment(data, { ...ctx, depth: ctx.depth + 1 });
      return [header, child].join('\n');
    }
    if (Array.isArray(data)) {
      const children = data
        .filter((item) => item != null)
        .map((item) => this.#arrayItem(item, ctx.depth + 1));
      return [header, ...children].join('\n');
    }
    if (isFragmentObject(data)) {
      const children = this.renderEntries(data, {
        ...ctx,
        depth: ctx.depth + 1,
      }).join('\n');
      return [header, children].join('\n');
    }
    return header;
  }

  protected renderPrimitive(
    key: string,
    value: string,
    ctx: RenderContext,
  ): string {
    return this.#leaf(key, value, ctx.depth);
  }

  protected renderArray(
    key: string,
    items: FragmentData[],
    ctx: RenderContext,
  ): string {
    const header = `${this.#pad(ctx.depth)}- **${key}**:`;
    const children = items
      .filter((item) => item != null)
      .map((item) => this.#arrayItem(item, ctx.depth + 1));
    return [header, ...children].join('\n');
  }

  protected renderObject(
    key: string,
    obj: FragmentObject,
    ctx: RenderContext,
  ): string {
    const header = `${this.#pad(ctx.depth)}- **${key}**:`;
    const children = this.renderEntries(obj, {
      ...ctx,
      depth: ctx.depth + 1,
    }).join('\n');
    return [header, children].join('\n');
  }
}

/**
 * Renders context fragments as TOML.
 */
export class TomlRenderer extends ContextRenderer {
  render(fragments: ContextFragment[]): string {
    const rendered: string[] = [];
    for (const f of this.sanitizeFragments(fragments)) {
      if (this.isPrimitive(f.data)) {
        return `${f.name} = ${this.#formatValue(f.data)}`;
      }
      if (Array.isArray(f.data)) {
        return this.#renderTopLevelArray(f.name, f.data);
      }
      if (isFragment(f.data)) {
        return [
          `[${f.name}]`,
          this.renderFragment(f.data, { depth: 0, path: [f.name] }),
        ].join('\n');
      }
      if (isFragmentObject(f.data)) {
        const entries = this.#renderObjectEntries(f.data, [f.name]);
        rendered.push([`[${f.name}]`, ...entries].join('\n'));
      }
    }
    return rendered.join('\n\n');
  }

  #renderTopLevelArray(name: string, items: FragmentData[]): string {
    const fragmentItems = items.filter(isFragment);
    const nonFragmentItems = items.filter(
      (item) => !isFragment(item) && item != null,
    );

    // If array contains fragments, render as sections
    if (fragmentItems.length > 0) {
      const parts: string[] = [`[${name}]`];
      for (const frag of fragmentItems) {
        parts.push(this.renderFragment(frag, { depth: 0, path: [name] }));
      }
      return parts.join('\n');
    }

    // Otherwise render as inline array
    const values = nonFragmentItems.map((item) => this.#formatValue(item));
    return `${name} = [${values.join(', ')}]`;
  }

  /**
   * Override renderValue to preserve type information for TOML formatting.
   */
  protected override renderValue(
    key: string,
    value: unknown,
    ctx: RenderContext,
  ): string {
    if (value == null) {
      return '';
    }
    if (isFragment(value)) {
      return this.renderFragment(value, ctx);
    }
    if (Array.isArray(value)) {
      return this.renderArray(key, value, ctx);
    }
    if (isFragmentObject(value)) {
      return this.renderObject(key, value, ctx);
    }
    // Preserve original type for TOML formatting
    return `${key} = ${this.#formatValue(value)}`;
  }

  protected renderPrimitive(
    key: string,
    value: string,
    ctx: RenderContext,
  ): string {
    void ctx;
    return `${key} = ${this.#formatValue(value)}`;
  }

  protected renderArray(
    key: string,
    items: FragmentData[],
    ctx: RenderContext,
  ): string {
    void ctx;
    const values = items
      .filter((item) => item != null)
      .map((item) => this.#formatValue(item));
    return `${key} = [${values.join(', ')}]`;
  }

  protected renderObject(
    key: string,
    obj: FragmentObject,
    ctx: RenderContext,
  ): string {
    const newPath = [...ctx.path, key];
    const entries = this.#renderObjectEntries(obj, newPath);
    return ['', `[${newPath.join('.')}]`, ...entries].join('\n');
  }

  #renderObjectEntries(obj: FragmentObject, path: string[]): string[] {
    return Object.entries(obj)
      .map(([key, value]) => {
        if (value == null) {
          return '';
        }
        if (isFragmentObject(value)) {
          const newPath = [...path, key];
          const entries = this.#renderObjectEntries(value, newPath);
          return ['', `[${newPath.join('.')}]`, ...entries].join('\n');
        }
        if (Array.isArray(value)) {
          const values = value
            .filter((item) => item != null)
            .map((item) => this.#formatValue(item));
          return `${key} = [${values.join(', ')}]`;
        }
        return `${key} = ${this.#formatValue(value)}`;
      })
      .filter(Boolean);
  }

  protected renderFragment(
    fragment: ContextFragment,
    ctx: RenderContext,
  ): string {
    const { name, data } = fragment;
    const newPath = [...ctx.path, name];
    if (this.isPrimitive(data)) {
      return `${name} = ${this.#formatValue(data)}`;
    }
    if (isFragment(data)) {
      return [
        '',
        `[${newPath.join('.')}]`,
        this.renderFragment(data, { ...ctx, path: newPath }),
      ].join('\n');
    }
    if (Array.isArray(data)) {
      const fragmentItems = data.filter(isFragment);
      const nonFragmentItems = data.filter(
        (item) => !isFragment(item) && item != null,
      );

      if (fragmentItems.length > 0) {
        const parts: string[] = ['', `[${newPath.join('.')}]`];
        for (const frag of fragmentItems) {
          parts.push(this.renderFragment(frag, { ...ctx, path: newPath }));
        }
        return parts.join('\n');
      }

      const values = nonFragmentItems.map((item) => this.#formatValue(item));
      return `${name} = [${values.join(', ')}]`;
    }
    if (isFragmentObject(data)) {
      const entries = this.#renderObjectEntries(data, newPath);
      return ['', `[${newPath.join('.')}]`, ...entries].join('\n');
    }
    return '';
  }

  #escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  #formatValue(value: unknown): string {
    if (typeof value === 'string') {
      return `"${this.#escape(value)}"`;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    return `"${String(value)}"`;
  }
}

/**
 * Renders context fragments as TOON (Token-Oriented Object Notation).
 * TOON is a compact, token-efficient format for LLM prompts that combines
 * YAML-like indentation with CSV-like tabular arrays.
 */
export class ToonRenderer extends ContextRenderer {
  render(fragments: ContextFragment[]): string {
    const sanitized = this.sanitizeFragments(fragments);
    return sanitized
      .map((f) => this.#renderTopLevel(f))
      .filter(Boolean)
      .join('\n');
  }

  #renderTopLevel(fragment: ContextFragment): string {
    const { name, data } = fragment;
    if (this.isPrimitive(data)) {
      return `${name}: ${this.#formatValue(data)}`;
    }
    if (Array.isArray(data)) {
      return this.#renderArrayField(name, data, 0);
    }
    if (isFragment(data)) {
      const child = this.renderFragment(data, { depth: 1, path: [] });
      return `${name}:\n${child}`;
    }
    if (isFragmentObject(data)) {
      const entries = this.#renderObjectEntries(data, 1);
      if (!entries) {
        return `${name}:`;
      }
      return `${name}:\n${entries}`;
    }
    return `${name}:`;
  }

  #renderArrayField(key: string, items: FragmentData[], depth: number): string {
    const filtered = items.filter((item) => item != null);
    if (filtered.length === 0) {
      return `${this.#pad(depth)}${key}[0]:`;
    }

    // Check for ContextFragment items
    const fragmentItems = filtered.filter(isFragment);
    if (fragmentItems.length > 0) {
      return this.#renderMixedArray(key, filtered, depth);
    }

    // Check if all items are primitives
    if (filtered.every((item) => this.#isPrimitiveValue(item))) {
      return this.#renderPrimitiveArray(key, filtered, depth);
    }

    // Check if tabular (uniform objects with primitive values)
    if (this.#isTabularArray(filtered)) {
      return this.#renderTabularArray(key, filtered, depth);
    }

    // Mixed array
    return this.#renderMixedArray(key, filtered, depth);
  }

  #isPrimitiveValue(value: unknown): boolean {
    return (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    );
  }

  #isTabularArray(items: FragmentData[]): items is FragmentObject[] {
    if (items.length === 0) return false;

    // All items must be objects (not arrays, not primitives, not fragments)
    const objects = items.filter(isFragmentObject);
    if (objects.length !== items.length) return false;

    // Determine if there is at least one shared field across all rows.
    // We treat null/undefined/missing as "empty" cells, but we still require
    // a non-empty key intersection so clearly non-uniform objects are not
    // forced into a tabular shape.
    let intersection = new Set<string>(Object.keys(objects[0]));
    for (const obj of objects) {
      const keys = new Set(Object.keys(obj));
      intersection = new Set([...intersection].filter((k) => keys.has(k)));

      for (const value of Object.values(obj)) {
        if (value == null) continue;
        if (!this.#isPrimitiveValue(value)) {
          return false;
        }
      }
    }

    return intersection.size > 0;
  }

  #renderPrimitiveArray(
    key: string,
    items: FragmentData[],
    depth: number,
  ): string {
    const values = items.map((item) => this.#formatValue(item)).join(',');
    return `${this.#pad(depth)}${key}[${items.length}]: ${values}`;
  }

  #renderTabularArray(
    key: string,
    items: FragmentObject[],
    depth: number,
  ): string {
    if (items.length === 0) {
      return `${this.#pad(depth)}${key}[0]:`;
    }

    const fields = Array.from(
      new Set(items.flatMap((obj) => Object.keys(obj))),
    );
    const header = `${this.#pad(depth)}${key}[${items.length}]{${fields.join(',')}}:`;

    const rows = items.map((obj) => {
      const values = fields.map((f) => {
        const value = obj[f];
        if (value == null) return '';
        return this.#formatValue(value);
      });
      return `${this.#pad(depth + 1)}${values.join(',')}`;
    });

    return [header, ...rows].join('\n');
  }

  #renderMixedArray(key: string, items: FragmentData[], depth: number): string {
    const header = `${this.#pad(depth)}${key}[${items.length}]:`;
    const lines = items.map((item) => this.#renderListItem(item, depth + 1));
    return [header, ...lines].join('\n');
  }

  #renderListItem(item: FragmentData, depth: number): string {
    if (this.#isPrimitiveValue(item)) {
      return `${this.#pad(depth)}- ${this.#formatValue(item)}`;
    }
    if (isFragment(item)) {
      const rendered = this.renderFragment(item, {
        depth: depth + 1,
        path: [],
      });
      // For fragments, render key: value on same line as hyphen if primitive
      if (this.isPrimitive(item.data)) {
        return `${this.#pad(depth)}- ${item.name}: ${this.#formatValue(item.data)}`;
      }
      return `${this.#pad(depth)}- ${item.name}:\n${rendered.split('\n').slice(1).join('\n')}`;
    }
    if (Array.isArray(item)) {
      // Nested array
      const content = this.#renderArrayField('', item, depth + 1);
      return `${this.#pad(depth)}-${content.trimStart()}`;
    }
    if (isFragmentObject(item)) {
      // Object in list
      const entries = this.#renderObjectEntries(item, depth + 1);
      if (!entries) {
        return `${this.#pad(depth)}-`;
      }
      // First line on same line as hyphen
      const lines = entries.split('\n');
      const first = lines[0].trimStart();
      const rest = lines.slice(1).join('\n');
      return rest
        ? `${this.#pad(depth)}- ${first}\n${rest}`
        : `${this.#pad(depth)}- ${first}`;
    }
    return `${this.#pad(depth)}- ${this.#formatValue(item)}`;
  }

  #renderObjectEntries(obj: FragmentObject, depth: number): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value == null) continue;

      if (this.#isPrimitiveValue(value)) {
        lines.push(`${this.#pad(depth)}${key}: ${this.#formatValue(value)}`);
      } else if (Array.isArray(value)) {
        lines.push(this.#renderArrayField(key, value, depth));
      } else if (isFragmentObject(value)) {
        const nested = this.#renderObjectEntries(value, depth + 1);
        if (nested) {
          lines.push(`${this.#pad(depth)}${key}:\n${nested}`);
        } else {
          lines.push(`${this.#pad(depth)}${key}:`);
        }
      }
    }
    return lines.join('\n');
  }

  protected renderFragment(
    fragment: ContextFragment,
    ctx: RenderContext,
  ): string {
    const { name, data } = fragment;
    if (this.isPrimitive(data)) {
      return `${this.#pad(ctx.depth)}${name}: ${this.#formatValue(data)}`;
    }
    if (isFragment(data)) {
      const child = this.renderFragment(data, {
        ...ctx,
        depth: ctx.depth + 1,
      });
      return `${this.#pad(ctx.depth)}${name}:\n${child}`;
    }
    if (Array.isArray(data)) {
      return this.#renderArrayField(name, data, ctx.depth);
    }
    if (isFragmentObject(data)) {
      const entries = this.#renderObjectEntries(data, ctx.depth + 1);
      if (!entries) {
        return `${this.#pad(ctx.depth)}${name}:`;
      }
      return `${this.#pad(ctx.depth)}${name}:\n${entries}`;
    }
    return `${this.#pad(ctx.depth)}${name}:`;
  }

  protected renderPrimitive(
    key: string,
    value: string,
    ctx: RenderContext,
  ): string {
    return `${this.#pad(ctx.depth)}${key}: ${this.#formatValue(value)}`;
  }

  protected renderArray(
    key: string,
    items: FragmentData[],
    ctx: RenderContext,
  ): string {
    return this.#renderArrayField(key, items, ctx.depth);
  }

  protected renderObject(
    key: string,
    obj: FragmentObject,
    ctx: RenderContext,
  ): string {
    const entries = this.#renderObjectEntries(obj, ctx.depth + 1);
    if (!entries) {
      return `${this.#pad(ctx.depth)}${key}:`;
    }
    return `${this.#pad(ctx.depth)}${key}:\n${entries}`;
  }

  #pad(depth: number): string {
    return '  '.repeat(depth);
  }

  #needsQuoting(value: string): boolean {
    if (value === '') return true;
    if (value !== value.trim()) return true;
    if (['true', 'false', 'null'].includes(value.toLowerCase())) return true;
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return true;
    if (/[:\\"'[\]{}|,\t\n\r]/.test(value)) return true;
    if (value.startsWith('-')) return true;
    return false;
  }

  #escape(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  #canonicalizeNumber(n: number): string {
    if (!Number.isFinite(n)) return 'null';
    if (Object.is(n, -0)) return '0';
    return String(n);
  }

  #formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return this.#canonicalizeNumber(value);
    if (typeof value === 'string') {
      if (this.#needsQuoting(value)) {
        return `"${this.#escape(value)}"`;
      }
      return value;
    }
    // Fallback for objects/arrays in primitive context
    return `"${this.#escape(JSON.stringify(value))}"`;
  }
}
