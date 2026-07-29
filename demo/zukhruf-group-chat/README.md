# demo-zukhruf-group-chat

A runnable composition of Microsoft's
[group chat orchestration pattern](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns#group-chat-orchestration)
using the existing Zukhruf and sandbox primitives.

The root Zukhruf agent is the chat manager. It reads the accumulating public
transcript, selects exactly one next speaker, waits for that participant's
durable `FINAL_ANSWER`, and writes the authored contribution back to the
transcript. Three independent participant chats cover community,
environmental, and budget perspectives.

All four agents bind mount the same dedicated host directory:

- The manager has a read-write mount and is the only transcript writer.
- Participants have read-only mounts and must read the full transcript before
  contributing.
- Each run stores its host-visible transcript at
  `.runtime/<run-id>/transcript.md` and mounts that directory at `/group-chat`
  inside every microVM.
- `spawn_agent` and `followup_task` control who gets the floor.
- `wait_agent` and durable mailbox completion return the contribution to the
  manager.
- The manager stops at consensus or after six contributions.

This is group chat rather than supervisor-style delegation because later
participants respond to the public, authored contributions of earlier
participants. Their shared context is not limited to private task inputs and
results held by the root.

## Run

Microsandbox must be installed and available:

```sh
msb --version
```

Then run the park-proposal scenario:

```sh
OPENAI_API_KEY=… npm start --workspace @deepagents/demo-zukhruf-group-chat
```

The CLI prints both the manager's final consensus and the complete shared
transcript, including its host path. Runtime transcripts remain under
`.runtime/` for direct inspection and are excluded from Git.
