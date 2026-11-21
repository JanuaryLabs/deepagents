import type { Capability, Guidance, Role, ToolNamer } from './capability.ts';
import { followupTaskTool, sendMessageTool } from './message-tools.ts';

/** Messages another agent directly: `send_message` and `followup_task`. */
export class DirectMessaging implements Capability {
  readonly tools = {
    send_message: sendMessageTool,
    followup_task: followupTaskTool,
  };

  guidance(role: Role, name: ToolNamer): Guidance {
    return {
      uses: [
        `\`${name('followup_task')}\` to assign a new task and trigger a turn`,
        role === 'root'
          ? `\`${name('send_message')}\` to queue a message without triggering a turn`
          : `\`${name('send_message')}\` to queue a message for another agent`,
      ],
    };
  }
}
