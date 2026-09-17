import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Reasoning,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamResult,
  LanguageModelV4Text,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';

/**
 * Folds a doStream result into a doGenerate result for transports that only
 * serve streaming calls. The assembled content parts plus the finish chunk's
 * usage and reason carry everything a non-streaming caller needs.
 */
export async function generateViaStream(
  streamResult: LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = [];
  const warnings: LanguageModelV4GenerateResult['warnings'] = [];
  const textParts = new Map<string, LanguageModelV4Text>();
  const reasoningParts = new Map<string, LanguageModelV4Reasoning>();
  let usage: LanguageModelV4Usage = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  let finishReason: LanguageModelV4FinishReason = {
    unified: 'other',
    raw: undefined,
  };
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  let responseMetadata: LanguageModelV4ResponseMetadata | undefined;

  for await (const part of streamResult.stream) {
    switch (part.type) {
      case 'stream-start':
        warnings.push(...part.warnings);
        break;
      case 'text-start': {
        const text: LanguageModelV4Text = { type: 'text', text: '' };
        if (part.providerMetadata) {
          text.providerMetadata = part.providerMetadata;
        }
        textParts.set(part.id, text);
        content.push(text);
        break;
      }
      case 'text-delta': {
        const text = textParts.get(part.id);
        if (text) {
          text.text += part.delta;
          if (part.providerMetadata) {
            text.providerMetadata = part.providerMetadata;
          }
        }
        break;
      }
      case 'text-end': {
        const text = textParts.get(part.id);
        if (text && part.providerMetadata) {
          text.providerMetadata = part.providerMetadata;
        }
        textParts.delete(part.id);
        break;
      }
      case 'reasoning-start': {
        const reasoning: LanguageModelV4Reasoning = {
          type: 'reasoning',
          text: '',
        };
        if (part.providerMetadata) {
          reasoning.providerMetadata = part.providerMetadata;
        }
        reasoningParts.set(part.id, reasoning);
        content.push(reasoning);
        break;
      }
      case 'reasoning-delta': {
        const reasoning = reasoningParts.get(part.id);
        if (reasoning) {
          reasoning.text += part.delta;
          if (part.providerMetadata) {
            reasoning.providerMetadata = part.providerMetadata;
          }
        }
        break;
      }
      case 'reasoning-end': {
        const reasoning = reasoningParts.get(part.id);
        if (reasoning && part.providerMetadata) {
          reasoning.providerMetadata = part.providerMetadata;
        }
        reasoningParts.delete(part.id);
        break;
      }
      case 'tool-call':
      case 'tool-result':
      case 'tool-approval-request':
      case 'file':
      case 'reasoning-file':
      case 'source':
      case 'custom':
        content.push(part);
        break;
      case 'response-metadata':
        responseMetadata = {
          ...(part.id !== undefined && { id: part.id }),
          ...(part.timestamp !== undefined && { timestamp: part.timestamp }),
          ...(part.modelId !== undefined && { modelId: part.modelId }),
        };
        break;
      case 'finish':
        usage = part.usage;
        finishReason = part.finishReason;
        if (part.providerMetadata) {
          providerMetadata = part.providerMetadata;
        }
        break;
      case 'error':
        throw part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
      // Complete tool-call parts follow the input deltas, so the deltas carry
      // no extra information for an aggregated result.
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'raw':
        break;
    }
  }

  return {
    content,
    finishReason,
    usage,
    warnings,
    ...(providerMetadata && { providerMetadata }),
    ...(streamResult.request && { request: streamResult.request }),
    ...((responseMetadata ?? streamResult.response) && {
      response: {
        ...responseMetadata,
        ...(streamResult.response?.headers && {
          headers: streamResult.response.headers,
        }),
      },
    }),
  };
}
