import type * as models from '../index.ts';

export type GetSuite = {
  runs: models.RunRow[];
  stats: {
    totalCases: number;
    totalFail: number;
    totalLatency: number;
    totalPass: number;
    totalTokens: number;
  };
  suite: models.SuiteRow;
};

export type GetSuite400 =
  | {
      cause: { code: 'api/invalid-json'; detail: string };
      message: 'The request body is not valid JSON';
    }
  | {
      cause: {
        code: 'api/validation-failed';
        detail: 'The input data is invalid';
        errors: { [key: string]: any };
      };
      message: 'Validation failed';
    };

export type GetSuite404 = { message: 'Suite not found' };

export type GetSuite415 =
  | {
      cause: {
        code: 'api/unsupported-media-type';
        detail: 'GET requests cannot have a content type header';
      };
      message: 'Unsupported Media Type';
    }
  | {
      cause: {
        code: 'api/unsupported-media-type';
        detail: 'Missing content type header';
      };
      message: 'Unsupported Media Type';
    }
  | {
      cause: { code: 'api/unsupported-media-type'; detail: string };
      message: 'Unsupported Media Type';
    };
