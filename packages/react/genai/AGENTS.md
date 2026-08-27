# @deepagents/react-genai

This package provides reusable chat, composer, message, trajectory, dynamic
rendering, and interactive-element primitives for React hosts.

## Module seam

- The package is application-agnostic and must not call a product API.
- Hosts inject the AI SDK `ChatTransport`, tool registry, interactive elements,
  and application behavior through the exported providers and contexts.
- HTTP adapters belong to the consuming host, such as the DeepAgents devtool.
- Reusable presentation primitives live under `src/lib/ui`; product-specific
  renderers and vocabulary stay in their host application.

## Composition

Prefer compound primitives backed by context. Keep default assemblies
fetch-free so hosts can recompose them without replacing package internals.
