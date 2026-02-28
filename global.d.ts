declare module '*.txt' {
  const content: string;
  export default content;
}

declare module '*.sql' {
  const content: string;
  export default content;
}

declare module '*.md' {
  const content: string;
  export default content;
}

declare module 'tiny-tfidf' {
  export class Corpus {
    constructor(
      names: string[],
      texts: string[],
      options?: {
        useDefaultStopwords?: boolean;
        customStopwords?: string[];
        K1?: number;
        b?: number;
      },
    );
    getTerms(): string[];
    getCollectionFrequency(term: string): number | null;
    getDocument(identifier: string): Document;
    getDocumentIdentifiers(): string[];
    getDocumentVector(identifier: string): Map<string, number>;
    getTopTermsForDocument(
      identifier: string,
      maxTerms?: number,
    ): [string, number][];
    getResultsForQuery(query: string): [string, number][];
    getCommonTerms(
      identifier1: string,
      identifier2: string,
      maxTerms?: number,
    ): [string, number][];
    addDocument(identifier: string, text: string): boolean;
  }

  export class Document {
    constructor(text: string);
    getLength(): number;
    getTermFrequency(term: string): number;
    getUniqueTerms(): string[];
  }

  export class Similarity {
    static cosineSimilarity(
      vector1: Map<string, number>,
      vector2: Map<string, number>,
    ): number;
  }

  export class Stopwords {
    constructor(useDefaults: boolean, custom?: string[]);
    includes(term: string): boolean;
  }
}
