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
import * as datasets from '../inputs/datasets.ts';
import * as outputs from '../outputs/index.ts';
import {
  CursorPagination,
  OffsetPagination,
  Pagination,
} from '../pagination/index.ts';

export default {
  'GET /datasets': {
    schema: datasets.listDatasetsSchema,
    output: [
      http.Ok<outputs.ListDatasets>,
      http.BadRequest<outputs.ListDatasets400>,
      http.UnsupportedMediaType<outputs.ListDatasets415>,
    ],
    toRequest(input: z.input<typeof datasets.listDatasetsSchema>) {
      return toRequest(
        'GET /datasets',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof datasets.listDatasetsSchema>,
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
  'POST /datasets': {
    schema: datasets.uploadDatasetSchema,
    output: [
      http.Created<outputs.UploadDataset201>,
      http.BadRequest<outputs.UploadDataset400>,
      http.UnsupportedMediaType<outputs.UploadDataset415>,
    ],
    toRequest(input: z.input<typeof datasets.uploadDatasetSchema>) {
      return toRequest(
        'POST /datasets',
        formdata(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: ['file'],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof datasets.uploadDatasetSchema>,
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
  'POST /datasets/import-hf': {
    schema: datasets.importHfDatasetSchema,
    output: [
      http.Created<outputs.ImportHfDataset201>,
      http.BadRequest<outputs.ImportHfDataset400>,
      http.UnsupportedMediaType<outputs.ImportHfDataset415>,
    ],
    toRequest(input: z.input<typeof datasets.importHfDatasetSchema>) {
      return toRequest(
        'POST /datasets/import-hf',
        json(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: ['config', 'dataset', 'split'],
          inputParams: [],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof datasets.importHfDatasetSchema>,
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
  'GET /datasets/{name}/rows': {
    schema: datasets.getDatasetRowsSchema,
    output: [
      http.Ok<outputs.GetDatasetRows>,
      http.BadRequest<outputs.GetDatasetRows400>,
      http.NotFound<outputs.GetDatasetRows404>,
      http.UnsupportedMediaType<outputs.GetDatasetRows415>,
    ],
    toRequest(input: z.input<typeof datasets.getDatasetRowsSchema>) {
      return toRequest(
        'GET /datasets/{name}/rows',
        empty(input, {
          inputHeaders: [],
          inputQuery: ['offset', 'limit'],
          inputBody: [],
          inputParams: ['name'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof datasets.getDatasetRowsSchema>,
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
  'DELETE /datasets/{name}': {
    schema: datasets.deleteDatasetSchema,
    output: [
      http.NoContent,
      http.BadRequest<outputs.DeleteDataset400>,
      http.NotFound<outputs.DeleteDataset404>,
      http.UnsupportedMediaType<outputs.DeleteDataset415>,
    ],
    toRequest(input: z.input<typeof datasets.deleteDatasetSchema>) {
      return toRequest(
        'DELETE /datasets/{name}',
        empty(input, {
          inputHeaders: [],
          inputQuery: [],
          inputBody: [],
          inputParams: ['name'],
        }),
      );
    },
    async dispatch(
      input: z.input<typeof datasets.deleteDatasetSchema>,
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
