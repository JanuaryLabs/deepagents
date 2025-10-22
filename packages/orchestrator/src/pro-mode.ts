import { groq } from '@ai-sdk/groq';
import { type ModelMessage, generateText } from 'ai';
import { writeFile } from 'node:fs/promises';

const MAX_OUTPUT_TOKENS = 30_000;
const MAX_PARALLELISM = 16;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;
const CANDIDATE_TEMPERATURE = 0.9;
const SYNTHESIS_TEMPERATURE = 0.2;

export interface ProModeResult {
  final: string;
  candidates: string[];
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function generateCompletion(
  prompt: string,
  temperature: number,
): Promise<string> {
  let delay = INITIAL_BACKOFF_MS;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < MAX_ATTEMPTS) {
    try {
      const { text } = await generateText({
        model: groq('openai/gpt-oss-20b'),
        prompt,
        temperature,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      return text;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= MAX_ATTEMPTS) {
        break;
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  throw new Error('Failed to generate completion after retries', {
    cause: lastError,
  });
}

function buildSynthesisMessages(candidates: string[]): ModelMessage[] {
  const numberedCandidates = candidates
    .map(
      (candidate, index) =>
        `<cand ${index + 1}>\n${candidate}\n</cand ${index + 1}>`,
    )
    .join('\n\n');

  const system =
    'You are an expert editor. Synthesize ONE best answer from the candidate answers provided, merging strengths, correcting errors, and removing repetition. Do not mention the candidates or the synthesis process. Be decisive and clear.';

  const user = `You are given ${candidates.length} candidate answers delimited by <cand i> tags.\n\n${numberedCandidates}\n\nReturn the single best final answer.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function generateCandidates(prompt: string, runs: number) {
  const maxWorkers = Math.min(runs, MAX_PARALLELISM);
  const candidates = new Array<string>(runs);
  let nextIndex = 0;

  const workers = Array.from({ length: maxWorkers }, async () => {
    while (true) {
      const currentIndex = nextIndex++;

      if (currentIndex >= runs) {
        break;
      }

      candidates[currentIndex] = await generateCompletion(
        prompt,
        CANDIDATE_TEMPERATURE,
      );
    }
  });

  await Promise.all(workers);
  return candidates;
}

export async function proMode(
  prompt: string,
  runs: number,
): Promise<ProModeResult> {
  if (runs < 1) {
    throw new Error('runs must be >= 1');
  }

  const candidates = await generateCandidates(prompt, runs);
  const messages = buildSynthesisMessages(candidates);

  const { text: final } = await generateText({
    model: groq('openai/gpt-oss-20b'),
    messages,
    temperature: SYNTHESIS_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  return { final, candidates };
}

const result = await proMode('How to build deepresearch agent?', 5);
for (let i = 0; i < result.candidates.length; i++) {
  await writeFile(`candidate_${i + 1}.txt`, result.candidates[i]);
}
await writeFile('final_answer.txt', result.final);
