# demo-zukhruf-mailbox

A deterministic, API-key-free demonstration of the first-class mailbox in
`@deepagents/experimental/zukhruf`.

The demo creates explicit `root` and `researcher` conversations, queues three
messages without scheduling work, then sends one trigger-turn message. It
starts the real Zukhruf worker, prints the exact mailbox messages passed to the
AI SDK model boundary, and verifies that all four messages became separate
durable history items in FIFO order.

It uses `MockLanguageModelV4` only to make the provider request observable and
repeatable. `AgentRuntime` owns delivery, wake scheduling, mailbox consumption,
and model execution. Persistence, pg-boss scheduling, and context-history
writes use the real package APIs.

Mailbox consumption is intentionally a destructive FIFO drain. The runtime
writes durable conversation history after it incorporates drained mail, but it
does not acknowledge or redeliver communications. A crash or history-write
failure after the drain can therefore lose that mail.

## Run

From the repository root:

```sh
npm run start --workspace=@deepagents/demo-zukhruf-mailbox
```

Expected checkpoints:

```text
1. Queue three messages without waking the researcher.
{ pendingMail: true, scheduledTurns: 0 }

2. Deliver one trigger-turn message.
{ scheduledTurns: 1, wakeKind: 'mailbox', payloadLivesInMailbox: true }

3. Start the worker and inspect the real model prompt.
--- model message 1 ---
Message Type: MESSAGE
...
--- model message 4 ---
Message Type: NEW_TASK
...

4. Verify consumption and durable history.
{
  modelVisibleMailboxMessages: 4,
  durableMailboxHistoryItems: 4,
  pendingAfterTurn: false
}
```
