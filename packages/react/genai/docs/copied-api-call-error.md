# Code copied inside react-genai

`ZukhrufChatTransport` turns a refused Zukhruf request into the AI SDK's `APICallError` in two places, the way the AI SDK's own `createUIApiCallError` does: `uploadFile` and `cancel` in `src/lib/chat/zukhruf-chat-transport.ts`. Each reads the response text as `responseBody` and keeps `statusCode` and `url`, so a host can map the failure without parsing a sentence.

The rule is copied, not shared, because it has two places (strike 2). Shared code is extracted when a third request of the transport needs it (backlog #6293). Until then, a fix in one copy is made in the other copy too, and the commit names both methods.

## Copied with changes

**`uploadFile` → `cancel`.**

- `uploadFile` sends the file as the body; `cancel` sends none, so its `requestBodyValues` is `undefined` in both.
- `cancel` resolves to nothing on a 2xx; `uploadFile` parses the receipt.
