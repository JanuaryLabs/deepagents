import type { ComponentType } from 'react';

import type { ElementDescriptor } from '@deepagents/elements';

export type ToolTip = {
  text: string;
  cooldown: 'frequent' | 'moderate' | 'rare';
  visibility?: 'always' | 'before-interaction' | 'after-interaction';
};

/**
 * A platform-neutral {@link ElementDescriptor} paired with the React
 * component that renders it. Only the descriptor projection crosses the
 * network (see `toDescriptor`); `component` and `tips` stay client-side.
 */
export interface GenAIInteractiveElement extends ElementDescriptor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- allowedAttributes defines the runtime prop interface for each registered element
  component: ComponentType<any>;
  tips?: ToolTip[];
}
