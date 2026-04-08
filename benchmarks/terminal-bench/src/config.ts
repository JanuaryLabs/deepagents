export interface HarnessConfig {
  maxOutputChars: number;
  temperature: number;
  enableBootstrap: boolean;
  enableContextInjection: boolean;
  enableSelfVerification: boolean;
  enableLoopDetection: boolean;
  enableScratchpad: boolean;
  enableSummarization: boolean;
}

export const defaultConfig: HarnessConfig = {
  maxOutputChars: 10_000,
  temperature: 0.7,
  enableBootstrap: true,
  enableContextInjection: true,
  enableSelfVerification: true,
  enableLoopDetection: true,
  enableScratchpad: true,
  enableSummarization: true,
};
