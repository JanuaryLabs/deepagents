import z from 'zod';

import {
  Dispatcher,
  type InstanceType,
  fetchType,
} from '../http/dispatcher.ts';
import {
  type Interceptor,
  createBaseUrlInterceptor,
  createHeadersInterceptor,
} from '../http/interceptors.ts';
import { buffered, chunked } from '../http/parse-response.ts';
import {
  type HeadersInit,
  empty,
  formdata,
  json,
  toRequest,
  urlencoded,
} from '../http/request.ts';
import * as http from '../http/response.ts';
import { sse } from '../http/sse.ts';
import * as prompts from '../inputs/prompts.ts';
import * as outputs from '../outputs/index.ts';
import {
  CursorPagination,
  OffsetPagination,
  Pagination,
} from '../pagination/index.ts';

export default {
  'GET /prompts': {
    schema: prompts.listPromptsSchema,
    output: [
      http.Ok<outputs.ListPrompts>,
      http.BadRequest<outputs.ListPrompts400>,
      http.UnsupportedMediaType<outputs.ListPrompts415>,
    ],
    toRequest(input: z.input<typeof prompts.listPromptsSchema>) {
      return toRequest(
        'GET /prompts',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof prompts.listPromptsSchema>,
      options: {
        signal?: AbortSignal;
        interceptors: Interceptor[];
        fetch: z.infer<typeof fetchType>;
      },
    ) {
      const dispatcher = new Dispatcher(options.interceptors, options.fetch);
      return dispatcher.send(
        this.toRequest(input),
        this.output,
        options?.signal,
      );
    },
  },
  'POST /prompts': {
    schema: prompts.createPromptSchema,
    output: [
      http.Created<outputs.PromptRow>,
      http.BadRequest<outputs.CreatePrompt400>,
      http.UnsupportedMediaType<outputs.CreatePrompt415>,
    ],
    toRequest(input: z.input<typeof prompts.createPromptSchema>) {
      return toRequest(
        'POST /prompts',
        json(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: ['content', 'name'],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof prompts.createPromptSchema>,
      options: {
        signal?: AbortSignal;
        interceptors: Interceptor[];
        fetch: z.infer<typeof fetchType>;
      },
    ) {
      const dispatcher = new Dispatcher(options.interceptors, options.fetch);
      return dispatcher.send(
        this.toRequest(input),
        this.output,
        options?.signal,
      );
    },
  },
  'GET /prompts/{id}': {
    schema: prompts.getPromptSchema,
    output: [
      http.Ok<outputs.PromptRow>,
      http.BadRequest<outputs.GetPrompt400>,
      http.NotFound<outputs.GetPrompt404>,
      http.UnsupportedMediaType<outputs.GetPrompt415>,
    ],
    toRequest(input: z.input<typeof prompts.getPromptSchema>) {
      return toRequest(
        'GET /prompts/{id}',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof prompts.getPromptSchema>,
      options: {
        signal?: AbortSignal;
        interceptors: Interceptor[];
        fetch: z.infer<typeof fetchType>;
      },
    ) {
      const dispatcher = new Dispatcher(options.interceptors, options.fetch);
      return dispatcher.send(
        this.toRequest(input),
        this.output,
        options?.signal,
      );
    },
  },
  'DELETE /prompts/{id}': {
    schema: prompts.deletePromptSchema,
    output: [
      http.NoContent,
      http.BadRequest<outputs.DeletePrompt400>,
      http.UnsupportedMediaType<outputs.DeletePrompt415>,
    ],
    toRequest(input: z.input<typeof prompts.deletePromptSchema>) {
      return toRequest(
        'DELETE /prompts/{id}',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof prompts.deletePromptSchema>,
      options: {
        signal?: AbortSignal;
        interceptors: Interceptor[];
        fetch: z.infer<typeof fetchType>;
      },
    ) {
      const dispatcher = new Dispatcher(options.interceptors, options.fetch);
      return dispatcher.send(
        this.toRequest(input),
        this.output,
        options?.signal,
      );
    },
  },
};
