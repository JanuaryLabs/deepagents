import * as ShadcnComponents from '@zukhruf/shadcn';
import { cn } from 'cn';
import * as React from 'react';

// Only expose safe React hooks - no useRef (DOM access), no useContext (escape scope)
const safeReactHooks = {
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useReducer: React.useReducer,
  useId: React.useId,
};

const safeReactUtils = {
  Fragment: React.Fragment,
  createElement: React.createElement,
};

// Create the safe scope object
export function createSafeScope(): Record<string, unknown> {
  return {
    // React hooks and utilities
    ...safeReactHooks,
    ...safeReactUtils,
    React: {
      ...safeReactHooks,
      ...safeReactUtils,
    },

    // All shadcn components
    ...ShadcnComponents,
    cn,

    // Block dangerous globals by setting them to undefined
    window: undefined,
    document: undefined,
    localStorage: undefined,
    sessionStorage: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    eval: undefined,
    Function: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    importScripts: undefined,
    navigator: undefined,
    location: undefined,
    history: undefined,
    console: undefined,
    alert: undefined,
    confirm: undefined,
    prompt: undefined,
  };
}

export function getScopeKeys(): string[] {
  return Object.keys(createSafeScope());
}

export function getScopeValues(): unknown[] {
  return Object.values(createSafeScope());
}
