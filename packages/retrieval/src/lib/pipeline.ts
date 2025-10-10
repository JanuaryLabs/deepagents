

// think about this.
// const pipeline = new Pipeline()
//   .source(new DatabaseAdapter('users'))
//   .transform(new UserToDocumentTransformer())
//   .split(new SemanticSplitter())
//   .embed(new OpenAIEmbedder())
//   .store(new VectorStore('users_index'));

export type Splitter = (id: string, content: string) => Promise<string[]>;
// export class Pipeline {
//   #connector: Connector;
//   #splitter: Splitter;
//   public source(connector: Connector) {
//     this.#connector = connector;
//     return this;
//   }
//   public split(splitter: Splitter) {
//     this.#splitter = splitter;
//     return this;
//   }
//   public embed(embedder: Embedder) {
//     this.#embedder = embedder;
//     return this;
//   }
//   public store(store: Store) {
//     this.#store = store;
//     return this;
//   }
// }

// const pipeline = new Pipeline();
// pipeline.source().split().embed().store();
