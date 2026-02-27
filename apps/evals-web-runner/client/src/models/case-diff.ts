export type CaseDiff = {
  index: number;
  scorerDeltas: {
    baseline: number;
    candidate: number;
    change: 'improved' | 'regressed' | 'unchanged';
    delta: number;
  };
};
