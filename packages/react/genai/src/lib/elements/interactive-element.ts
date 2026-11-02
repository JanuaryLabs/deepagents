import type { ComponentType } from 'react';
import type { ExtraProps } from 'streamdown';

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
  /**
   * Receives the element's markdown attributes as streamdown passes them:
   * untyped, so the component narrows each one it reads.
   */
  component: ComponentType<Record<string, unknown> & ExtraProps>;
  tips?: ToolTip[];
}
