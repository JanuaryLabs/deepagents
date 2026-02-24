import { openai } from '@ai-sdk/openai';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';

import { lmstudio } from '@deepagents/agent';

/**
 * Model variants for evaluation.
 * Easy to add/remove models - just update this array.
 */
export const EVAL_MODELS = [
  // {
  //   name: 'Groq Kimi-K2',
  //   input: { model: groq('moonshotai/kimi-k2-instruct-0905') },
  // },
  // {
  //   name: 'Groq GPT-OSS-20B',
  //   input: { model: groq('openai/gpt-oss-20b') },
  // },
  // {
  //   name: 'Qwen 3 4B',
  //   input: {
  //     model: wrapLanguageModel({
  //       model: lmstudio('qwen/qwen3-4b-2507'),
  //       middleware: defaultSettingsMiddleware({
  //         settings: {
  //           temperature: 0, // precision over creativity
  //           topP: 1, // allow flexibility
  //           presencePenalty: 0, // light repetition control
  //         },
  //       }),
  //     }),
  //   },
  // },
  {
    name: 'gpt-4.1-nano',
    input: {
      model: wrapLanguageModel({
        model: openai('gpt-4.1-nano'),
        middleware: defaultSettingsMiddleware({
          settings: {
            temperature: 0,
          },
        }),
      }),
    },
  },
  // {
  //   name: 'Cerebras GPT-OSS-120B',
  //   input: {
  //     model: wrapLanguageModel({
  //       model: cerebras('gpt-oss-120b'),
  //       middleware: defaultSettingsMiddleware({
  //         settings: {
  //           providerOptions: {
  //             cerebras: {
  //               reasoningEffort: 'low',
  //             },
  //           },
  //         },
  //       }),
  //     }),
  //   },
  // },
];

export type EvalVariant = (typeof EVAL_MODELS)[number]['input'];
