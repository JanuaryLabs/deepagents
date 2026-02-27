import type * as models from '../index.ts';

export type GetRun = {
  cases: models.CaseWithScores[];
  config: { [key: string]: any };
  run: models.RunRow;
  scorerNames: string[];
  suite: models.SuiteRow;
  summary: models.RunSummary;
};

export type GetRun400 =
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

export type GetRun404 = { message: 'Run not found' };

export type GetRun415 =
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

export type GetRun500 = { message: 'Suite not found for run' };
