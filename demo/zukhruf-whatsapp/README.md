# demo-zukhruf-whatsapp

A WhatsApp-style group made from five independent Zukhruf agents:

- researcher
- engineer
- product
- critic
- creative

There is no AI manager and no speaker selector. The TypeScript host behaves
like the WhatsApp service:

1. A public message is delivered to every other group member.
2. Their Zukhruf turns run concurrently.
3. Each agent decides whether its specialty provides something useful and
   non-duplicative.
4. An agent remains publicly silent unless it explicitly calls
   `reply_to_group`.
5. Public replies are delivered to every other member as the next notification
   batch.
6. The conversation becomes quiet when a complete batch produces no replies.

Ordinary assistant text remains private to the agent. This keeps “I saw it but
have nothing to add” out of the public conversation.

There is deliberately no maximum round or message count in this demo.

## Files

- `agent.ts`, `instructions.ts`, and `sandbox.ts` form the parameterized
  participant declaration.
- `tools/reply-to-group.ts` owns the public reply tool declaration.
- `whatsapp.ts` owns the group host and durable runtime lifecycle.
- `run.ts` owns the executable five-participant scenario.
- `channels/`, `connections/`, `schedules/`, `skills/`, and `subagents/` are
  reserved declaration slots.

## Run

```sh
OPENAI_API_KEY=… npm start --workspace @deepagents/demo-zukhruf-whatsapp
```

The demo uses a local-first AI product question.

## Verify

```sh
nx run @deepagents/demo-zukhruf-whatsapp:test
nx run @deepagents/demo-zukhruf-whatsapp:typecheck
```
