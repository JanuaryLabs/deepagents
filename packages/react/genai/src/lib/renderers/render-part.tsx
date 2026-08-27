import { type ToolUIPart } from 'ai';
import { Loader } from 'lucide-react';

import { useAgent } from '../chat/agent-context.tsx';

export function RenderPart({ part }: { part: ToolUIPart }) {
  const { registry } = useAgent();

  if (!part.input) {
    return <Loader className="size-4 animate-spin" />;
  }

  if (!registry) {
    return null;
  }

  const customRenderer = registry[part.type.replace('tool-', '')];
  if (customRenderer) {
    const Renderer = customRenderer.component;
    return (
      <div className="space-y-2">
        {registry.progress && <registry.progress.component part={part} />}
        <Renderer part={part} />
      </div>
    );
  } else {
    return registry.progress && <registry.progress.component part={part} />;
  }
}
