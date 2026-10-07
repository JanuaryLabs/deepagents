// Inline styles may set CSS custom properties, e.g. `--sidebar-width`.
declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}

export {};
