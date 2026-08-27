import { createContext } from 'react';

/**
 * True while a subtree renders into a static artifact (clipboard image, saved
 * PNG, printed PDF) rather than onto the interactive surface. Lives in its own
 * module so the portal that provides it and `useIsAssistantSnapshotRender` —
 * which stays exported from `assistant-snapshot.tsx` for its existing consumers
 * — can share it without importing each other.
 */
export const SnapshotRenderContext = createContext(false);
