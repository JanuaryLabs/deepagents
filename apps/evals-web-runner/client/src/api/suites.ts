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
import * as suites from '../inputs/suites.ts';
import * as outputs from '../outputs/index.ts';
import {
  CursorPagination,
  OffsetPagination,
  Pagination,
} from '../pagination/index.ts';

export default {
  'GET /suites': {
    schema: suites.listSuitesSchema,
    output: [
      http.Ok<outputs.ListSuites>,
      http.BadRequest<outputs.ListSuites400>,
      http.UnsupportedMediaType<outputs.ListSuites415>,
    ],
    toRequest(input: z.input<typeof suites.listSuitesSchema>) {
      return toRequest(
        'GET /suites',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof suites.listSuitesSchema>,
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
  'GET /suites/{id}': {
    schema: suites.getSuiteSchema,
    output: [
      http.Ok<outputs.GetSuite>,
      http.BadRequest<outputs.GetSuite400>,
      http.NotFound<outputs.GetSuite404>,
      http.UnsupportedMediaType<outputs.GetSuite415>,
    ],
    toRequest(input: z.input<typeof suites.getSuiteSchema>) {
      return toRequest(
        'GET /suites/{id}',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof suites.getSuiteSchema>,
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
  'PATCH /suites/{id}': {
    schema: suites.renameSuiteSchema,
    output: [
      http.Ok<outputs.RenameSuite>,
      http.BadRequest<outputs.RenameSuite400>,
      http.NotFound<outputs.RenameSuite404>,
      http.UnsupportedMediaType<outputs.RenameSuite415>,
    ],
    toRequest(input: z.input<typeof suites.renameSuiteSchema>) {
      return toRequest(
        'PATCH /suites/{id}',
        json(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: ['name'],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof suites.renameSuiteSchema>,
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
