export type DeleteDataset204 = ReadableStream;

export type DeleteDataset400 =
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

export type DeleteDataset404 = { message: string };

export type DeleteDataset415 =
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
