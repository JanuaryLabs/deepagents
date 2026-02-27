import type { SSEListener } from '../http/sse.ts';

export type StreamRunEvents = SSEListener;

export type StreamRunEvents400 =
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

export type StreamRunEvents415 =
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
