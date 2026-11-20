# react-input ships no words or icons, and react-genai ships ChatComposer.Dictate

Status: ruled by Ezz on 2026-11-20 (design for review).

## Context

Both copies give English labels ("Start voice input", "Microphone blocked — enable it in your browser site settings") and lucide icons from inside the library. Words belong to each product's voice and language.

text2sql's copy refuses a new recording while `useAgentStatus()` of `@workspace/genai` is `streaming` or `submitted`. blackboard's copy takes a `disabled` prop instead. `useAgentStatus` belongs to the chat kit: it lives in `@deepagents/react-genai` (`src/lib/chat/agent-context.tsx:189`). Thus each copy was right for its own layer.

`@deepagents/react-genai` already gives the look of the composer's parts: `ChatComposer.AttachFiles` is `Composer.AttachFiles` with a `ChatActionButton`, a Paperclip icon and the label "Attach files".

## Decision

- `Composer.Dictate` gives the dictation state, its error codes and `data-status`, and no words or icons.
- `ChatComposer.Dictate` is `Composer.Dictate` with a `ChatActionButton`, lucide icons and English labels. It passes `disabled` while `useAgentStatus()` is `streaming` or `submitted`.

## Consequences

- An app with its own words composes `Composer.Dictate`.
- `lucide-react` stays a dependency of `@deepagents/react-genai` only, where it already is.
