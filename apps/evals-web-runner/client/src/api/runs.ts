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
import * as runs from '../inputs/runs.ts';
import * as outputs from '../outputs/index.ts';
import {
  CursorPagination,
  OffsetPagination,
  Pagination,
} from '../pagination/index.ts';

export default {
  'GET /runs/{id}/events': {
    schema: runs.streamRunEventsSchema,
    output: [
      { type: http.Ok<outputs.StreamRunEvents>, parser: sse },
      http.BadRequest<outputs.StreamRunEvents400>,
      http.UnsupportedMediaType<outputs.StreamRunEvents415>,
    ],
    toRequest(input: z.input<typeof runs.streamRunEventsSchema>) {
      return toRequest(
        'GET /runs/{id}/events',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof runs.streamRunEventsSchema>,
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
  'GET /runs': {
    schema: runs.listRunsSchema,
    output: [
      http.Ok<outputs.ListRuns>,
      http.BadRequest<outputs.ListRuns400>,
      http.UnsupportedMediaType<outputs.ListRuns415>,
    ],
    toRequest(input: z.input<typeof runs.listRunsSchema>) {
      return toRequest(
        'GET /runs',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof runs.listRunsSchema>,
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
  'POST /runs': {
    schema: runs.createRunSchema,
    output: [
      http.Created<outputs.CreateRun201>,
      http.BadRequest<outputs.CreateRun400>,
      http.NotFound<outputs.CreateRun404>,
      http.UnsupportedMediaType<outputs.CreateRun415>,
    ],
    toRequest(input: z.input<typeof runs.createRunSchema>) {
      return toRequest(
        'POST /runs',
        json(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [
            'batchSize',
            'dataset',
            'endpointUrl',
            'maxConcurrency',
            'models',
            'name',
            'promptId',
            'recordSelection',
            'scorerModel',
            'scorers',
            'taskMode',
            'threshold',
            'timeout',
            'trials',
          ],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof runs.createRunSchema>,
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
  'GET /runs/{id}': {
    schema: runs.getRunSchema,
    output: [
      http.Ok<outputs.GetRun>,
      http.BadRequest<outputs.GetRun400>,
      http.NotFound<outputs.GetRun404>,
      http.UnsupportedMediaType<outputs.GetRun415>,
      http.InternalServerError<outputs.GetRun500>,
    ],
    toRequest(input: z.input<typeof runs.getRunSchema>) {
      return toRequest(
        'GET /runs/{id}',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof runs.getRunSchema>,
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
  'PATCH /runs/{id}': {
    schema: runs.renameRunSchema,
    output: [
      http.Ok<outputs.RenameRun>,
      http.BadRequest<outputs.RenameRun400>,
      http.NotFound<outputs.RenameRun404>,
      http.UnsupportedMediaType<outputs.RenameRun415>,
    ],
    toRequest(input: z.input<typeof runs.renameRunSchema>) {
      return toRequest(
        'PATCH /runs/{id}',
        json(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: ['name'],
          inputParams: ['id'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof runs.renameRunSchema>,
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
