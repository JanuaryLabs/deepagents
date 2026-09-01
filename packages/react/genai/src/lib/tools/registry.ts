import type { ToolUIPart } from 'ai';
import type { ComponentType } from 'react';
import type { ZodTypeAny } from 'zod';

import type { ToolTip } from '../elements/interactive-element.ts';

export type ToolLabel = {
  name: string;
  icon?: ComponentType<{ className?: string }>;
  actions?: ComponentType<{ part: ToolUIPart }>;
  args?: Record<string, string | undefined>;
  isError?: boolean;
  detail?: string;
};

export type StaticTool = {
  component: ComponentType<{ part: ToolUIPart }>;
  label?: (part: ToolUIPart) => ToolLabel;
  tips?: ToolTip[];
  static: true;
};

export type ComponentTool<TSchema extends ZodTypeAny = ZodTypeAny> = {
  component: ComponentType<{ part: ToolUIPart }>;
  label?: (part: ToolUIPart) => ToolLabel;
  inputSchema: TSchema;
  description: string;
  requiresUserInput?: boolean;
  tips?: ToolTip[];
  static?: false;
};

export type ComponentRegistry = Record<string, ComponentTool | StaticTool>;
