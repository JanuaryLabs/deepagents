import type { ToolUIPart } from 'ai';
import type { ComponentType } from 'react';
import type { ZodType } from 'zod';

import type { ToolTip } from '../elements/interactive-element.ts';

type ToolLabelBase = {
  icon?: ComponentType<{ className?: string }>;
  actions?: ComponentType<{ part: ToolUIPart }>;
  isError?: boolean;
  /** A second line under the step, drawn in the same form as the label. */
  detail?: string;
};

/** A developer call, drawn as `name(args)` in a monospace font. */
export type ToolCallLabel = ToolLabelBase & {
  kind?: 'call';
  name: string;
  args?: Record<string, string | undefined>;
};

/**
 * A step in the host's own words: the sentence is the step's whole line,
 * drawn in the body font and in its own text direction.
 */
export type ToolSentenceLabel = ToolLabelBase & {
  kind: 'sentence';
  text: string;
};

export type ToolLabel = ToolCallLabel | ToolSentenceLabel;

export type StaticTool = {
  component: ComponentType<{ part: ToolUIPart }>;
  label?: (part: ToolUIPart) => ToolLabel;
  tips?: ToolTip[];
  static: true;
};

export type ComponentTool<TSchema extends ZodType = ZodType> = {
  component: ComponentType<{ part: ToolUIPart }>;
  label?: (part: ToolUIPart) => ToolLabel;
  inputSchema: TSchema;
  description: string;
  requiresUserInput?: boolean;
  tips?: ToolTip[];
  static?: false;
};

export type ComponentRegistry = Record<string, ComponentTool | StaticTool>;
