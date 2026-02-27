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
import * as compare from '../inputs/compare.ts';
import * as outputs from '../outputs/index.ts';
import {
  CursorPagination,
  OffsetPagination,
  Pagination,
} from '../pagination/index.ts';

export default {
  'GET /compare/runs': {
    schema: compare.listCompletedRunsSchema,
    output: [
      http.Ok<outputs.ListCompletedRuns>,
      http.BadRequest<outputs.ListCompletedRuns400>,
      http.UnsupportedMediaType<outputs.ListCompletedRuns415>,
    ],
    toRequest(input: z.input<typeof compare.listCompletedRunsSchema>) {
      return toRequest(
        'GET /compare/runs',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof compare.listCompletedRunsSchema>,
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
  'GET /compare': {
    schema: compare.compareRunsSchema,
    output: [
      http.Ok<outputs.CompareRuns>,
      http.BadRequest<outputs.CompareRuns400>,
      http.NotFound<outputs.CompareRuns404>,
      http.UnsupportedMediaType<outputs.CompareRuns415>,
    ],
    toRequest(input: z.input<typeof compare.compareRunsSchema>) {
      return toRequest(
        'GET /compare',
        empty(input, {
          inputHeaders: [],
          inputQuery: ['baseline', 'candidate'],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof compare.compareRunsSchema>,
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
