import type { Bridge } from '../bridge.ts';

export interface MiddlewareSetupResult {
  [key: string]: string;
}

export interface Middleware {
  name: string;
  onSetup?(instruction: string, bridge: Bridge): Promise<MiddlewareSetupResult>;
  onTeardown?(): void;
}
