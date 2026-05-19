# Agno AI Knowledge — Deep Research Report

**Topic:** Everything about Agno's Knowledge subsystem (the RAG/vector layer inside AgentOS)
**Date:** 2026-05-19
**Mode:** Deep (8-phase pipeline, claim-triangulated)
**Agno release at research time:** v2.6.7 (latest as of 2026-05-15)
**Author audience:** Technical (framework builder reading for comparative architecture insight)

---

## Executive Summary

Agno is an open-source Python agent framework (40k+ stars, born as `phidata` in 2022, renamed in early 2025) with three integrated layers: a Python SDK, a stateless FastAPI runtime called **AgentOS**, and a **Control Plane UI** hosted at `os.agno.com`. Within that stack, **Knowledge** is the first-class abstraction for RAG: a `Knowledge` dataclass that pairs a `vector_db` (embeddings + chunks) with an optional `contents_db` (content rows, status machine, metadata), then attaches to one or more agents.

The most important things to know:

1. **Two-DB design.** Unlike LangChain or LlamaIndex where the vector store usually doubles as the system of record, Agno separates **embedding storage** (`VectorDb` ABC, 18 backends in source) from **content metadata** (`Content` rows in a `BaseDb` like `PostgresDb`, with a `PROCESSING / COMPLETED / FAILED` status machine). This enables CRUD + status tracking + deterministic deletion sync across both stores.

2. **Agentic RAG is the default.** When you do `Agent(knowledge=kb)`, Agno gives the agent a `search_knowledge_base()` _tool_ — the agent decides when to query, rephrases the query, and can chain searches. Setting `add_knowledge_to_context=True` switches to traditional auto-injection RAG; the two are mutually opt-in.

3. **Hybrid search is RRF.** `SearchType.hybrid` runs vector + keyword in parallel and fuses with Reciprocal Rank Fusion: `RRF(d) = Σ 1/(k + rank)`, default `k=60`. Six backends support it: PgVector, ChromaDB, LanceDB, Weaviate, Milvus, Pinecone.

4. **AgentOS exposes Knowledge as a managed plane.** 12 REST endpoints (upload, list, delete, search, status, sources) under `/knowledge/*`, mounted by `AgentOS(knowledge=[...]).get_app()`. Multi-KB resolution uses `?db_id=...&knowledge_id=...` query params. Ingestion runs in FastAPI `BackgroundTasks` and returns 202 immediately.

5. **Component breadth is real but smaller than the marketing line.** Docs say _"25+ vector databases"_; the actual `libs/agno/agno/vectordb/` directory ships **18** backends. Embedders: **19** in source vs _"29"_ in some search-result paraphrases. Readers: **18** in source. Chunkers: **8** strategies including `AgenticChunking` (LLM-picked breakpoints) and `CodeChunking` (AST-based, shipped Jan 2026).

6. **Known sharp edges.** `chunking_strategy` was silently ignored in v1.4.5 (#3126, still open at search time). `_update_content` bails with a warning if the row is missing — an in-source TODO already flags it as wrong (#7754). Multimodal RAG with image-bearing tool results hallucinates on GPT-5.2 (#5980). The headline **10,000× faster than LangChain** number is widely criticized on HN as measuring only client-object construction.

7. **The 6-month direction of travel.** Heavy investment in cloud-source ingestion (Azure Blob, GCS, GitHub, SharePoint, S3), new readers (Docling for tables/PDFs, LLMsTxt), and security hardening (SSRF `allowed_hosts` allowlists, content-hash includes remote-source identity, SentenceTransformer VRAM cleanup). The `v2.5 Phase 1` refactor (Feb 2026, PR #6429) is what produced the current `Knowledge(RemoteKnowledge)` shape with the explicit `vector_db` + `contents_db` split.

For a framework builder, the most transferable design choices are the **two-DB split**, the **flag-pair semantics** (`search_knowledge` vs `add_knowledge_to_context`), and the **AgentOS multi-KB routing model** (auto-discovery of agent-attached KBs + explicit `knowledge=[...]` orphans + deterministic `knowledge_id`).

---

## 1. Introduction

### 1.1 Scope

This report covers Agno's Knowledge subsystem end-to-end: the public Python API, the underlying class hierarchy in `agno-agi/agno`, supported readers/chunkers/embedders/vector DBs/rerankers, search semantics (vector/keyword/hybrid + reranker), agentic-RAG vs traditional-RAG behavior, the AgentOS management plane, real cookbook code, recent commits, known bugs, and a comparison snapshot against LangChain / LlamaIndex.

**In scope.** Public API surface, repo source at `libs/agno/agno/knowledge/` and `libs/agno/agno/vectordb/`, docs at `docs.agno.com/knowledge/*`, cookbook examples, AgentOS routers, recent commits since 2026-01, community write-ups and issues.

**Out of scope.** Pricing of hosted Agno products, non-Knowledge Agno features (Tools, Memory, Reasoning, Workflows) except where they interact with Knowledge.

### 1.2 Methodology

The investigation ran three parallel deep-dive subagents — one against the GitHub source, one against `docs.agno.com`, one against community/critical writeups — plus eight WebSearch queries and five targeted WebFetch calls. Every factual claim has at least one source in `evidence.jsonl`; claims that bear on architectural decisions were cross-checked against the source files directly because docs are not always in step with `main`.

Two ground rules:

- **Source code wins when docs disagree.** Agno is iterating fast (eleven minor/patch releases between 2026-04-10 and 2026-05-15) and the docs lag. The README's "25+ vector databases" line is marketing; the directory listing is truth.
- **Marketing benchmarks are reported as Agno's claim, not as fact.** The "10,000× faster" and "3μs instantiation" lines are not independently reproducible — they are reported with provenance and methodology footnotes.

### 1.3 Key assumptions

You are a framework builder, so the depth lives in the _shape_ of Agno's primitives — class signatures, control flow, integration seams — rather than in the marketing surface. Code snippets are quoted verbatim from the cookbook so you can compare to your own primitives instead of paraphrasing through a doc lens.

---

## 2. What Knowledge Is

### 2.1 The Knowledge class

`Knowledge` lives at `libs/agno/agno/knowledge/knowledge.py`. It is a Python dataclass that extends `RemoteKnowledge`:

```python
@dataclass
class Knowledge(RemoteKnowledge):
    """Knowledge class"""
    name: Optional[str] = None
    description: Optional[str] = None
    vector_db: Optional[Any] = None                       # cast to VectorDb at use
    contents_db: Optional[Union[BaseDb, AsyncBaseDb]] = None
    max_results: int = 10
    readers: Optional[Dict[str, Reader]] = None
    content_sources: Optional[List[BaseStorageConfig]] = None
    isolate_vector_search: bool = False
```

The public surface, in pairs of sync/async:

| Capability        | Sync                                                                                                                        | Async            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Ingest one item   | `insert`                                                                                                                    | `ainsert`        |
| Ingest many       | `insert_many`                                                                                                               | `ainsert_many`   |
| Search            | `search`                                                                                                                    | `asearch`        |
| Get/patch content | `get_content`, `patch_content`                                                                                              | `apatch_content` |
| Status            | `get_content_status`                                                                                                        | —                |
| Delete            | `remove_content_by_id`, `remove_all_content`, `remove_vector_by_id`, `remove_vectors_by_name`, `remove_vectors_by_metadata` | —                |
| Filters           | `get_valid_filters`, `validate_filters`                                                                                     | —                |
| Reader plumbing   | `construct_readers`, `add_reader`, `get_readers`                                                                            | —                |

`insert` is the single ingest verb — there is no `add_content`. It dispatches internally to `_load_from_path` / `_load_from_url` / `_load_from_content` based on which keyword the caller passed:

```python
def insert(
    self,
    name: Optional[str] = None,
    description: Optional[str] = None,
    path: Optional[str] = None,                  # filesystem path
    url: Optional[str] = None,                   # http(s) URL
    text_content: Optional[str] = None,          # raw text
    metadata: Optional[Dict[str, Any]] = None,
    topics: Optional[List[str]] = None,
    remote_content: Optional[RemoteContent] = None,
    reader: Optional[Reader] = None,
    include: Optional[List[str]] = None,
    exclude: Optional[List[str]] = None,
    upsert: bool = True,
    skip_if_exists: bool = False,
    auth: Optional[ContentAuth] = None,
) -> None
```

`search` returns a list of `Document` and accepts a runtime `search_type` override:

```python
def search(
    self,
    query: str,
    max_results: Optional[int] = None,
    filters: Optional[Union[Dict[str, Any], List[FilterExpr]]] = None,
    search_type: Optional[str] = None,
) -> List[Document]
```

If `search_type` is `None`, the backend's constructor-time default is used.

### 2.2 The Two-DB design

The single most distinctive architectural choice in Agno Knowledge is that `vector_db` and `contents_db` are independent:

- `vector_db` (`VectorDb` ABC) holds chunks + their embeddings. Backends include PgVector, Qdrant, LanceDB, Chroma, Pinecone, Weaviate, Milvus, MongoDB, Redis, Cassandra, ClickHouse, Couchbase, SingleStore, SurrealDB, Upstash, LangchainDb adapter, LlamaIndex adapter, LightRAG.
- `contents_db` (`BaseDb`, e.g. `PostgresDb`) holds **one `Content` row per ingested item**, with fields:

```python
@dataclass
class Content:
    id: str
    name, description, path, url
    auth: Optional[ContentAuth]
    file_data: Optional[bytes]
    metadata: Dict[str, Any]
    topics: List[str]
    remote_content: Optional[RemoteContent]
    reader: Optional[str]
    size: Optional[int]
    file_type: Optional[str]
    content_hash: str
    status: ContentStatus           # PROCESSING | COMPLETED | FAILED
    status_message: Optional[str]
    created_at, updated_at
    external_id: Optional[str]
```

```python
class ContentStatus(str, Enum):
    PROCESSING = "processing"
    COMPLETED  = "completed"
    FAILED     = "failed"
```

The status machine plus `content_hash` is what makes `skip_if_exists=True` cheap. The hash includes remote-source identity since PR #7515 (April 2026), so the same blob on different S3 buckets is treated as two contents — important for multi-tenant deployments.

The architectural payoff:

- **Visibility:** the UI/Control Plane can list everything that's been ingested and where it sits in the processing lifecycle.
- **Mutation:** patching name/description/metadata doesn't require re-embedding.
- **Deletion sync:** removing a `Content` row cascades to the vector rows by content id.
- **Backpressure:** ingestion can run in `BackgroundTasks` while the API call returns 202 — the status field is the source of truth for "ready to query."

The cost: writers have to keep two stores consistent, and there's no built-in distributed transaction. If `contents_db` write succeeds and `vector_db` write fails, the row sits in `PROCESSING` until a retry or operator intervention.

### 2.3 What `RemoteKnowledge` brings

`Knowledge` extends `RemoteKnowledge`, which gives it `content_sources: List[BaseStorageConfig]`. The five storage configs ship in `libs/agno/agno/knowledge/remote_content/`:

| Source               | Config class       | Notes                                                          |
| -------------------- | ------------------ | -------------------------------------------------------------- |
| Azure Blob           | `AzureBlobConfig`  | SAS-token auth since #7247 (Apr 2026)                          |
| Google Cloud Storage | `GCSConfig`        | —                                                              |
| GitHub               | `GitHubConfig`     | GitHub App auth (#6831) and per-request repo selection (#7496) |
| S3                   | `S3Config`         | —                                                              |
| SharePoint           | `SharePointConfig` | —                                                              |

The mirror directory `knowledge/loaders/` contains the actual iteration logic — given a `*Config`, it yields enumerated blobs and hands each one to the appropriate reader. This is the "browse a remote bucket from the AgentOS UI" feature.

---

## 3. Component Catalog

### 3.1 Readers (18)

| Reader                        | Module                        | Reads                                                     |
| ----------------------------- | ----------------------------- | --------------------------------------------------------- |
| `PDFReader`, `PDFImageReader` | `pdf_reader.py`               | PDF (text + image-OCR variants)                           |
| `CSVReader`                   | `csv_reader.py`               | CSV                                                       |
| `FieldLabeledCSVReader`       | `field_labeled_csv_reader.py` | CSV as field-labeled text                                 |
| `ExcelReader`                 | `excel_reader.py`             | XLSX/XLS (added #6129)                                    |
| `DocxReader`                  | `docx_reader.py`              | Word                                                      |
| `PPTXReader`                  | `pptx_reader.py`              | PowerPoint                                                |
| `JSONReader`                  | `json_reader.py`              | JSON                                                      |
| `MarkdownReader`              | `markdown_reader.py`          | Markdown                                                  |
| `TextReader`                  | `text_reader.py`              | Plaintext (default fallback)                              |
| `WebsiteReader`               | `website_reader.py`           | Recursive crawl                                           |
| `FirecrawlReader`             | `firecrawl_reader.py`         | Firecrawl crawl API                                       |
| `TavilyReader`                | `tavily_reader.py`            | Tavily search results                                     |
| `WebSearchReader`             | `web_search_reader.py`        | Generic web-search wrapper                                |
| `YouTubeReader`               | `youtube_reader.py`           | YouTube transcripts                                       |
| `ArxivReader`                 | `arxiv_reader.py`             | arXiv abstracts/papers                                    |
| `WikipediaReader`             | `wikipedia_reader.py`         | Wikipedia                                                 |
| `LLMsTxtReader`               | `llms_txt_reader.py`          | `llms.txt` (added Apr 2026 #7458)                         |
| `DoclingReader`               | `docling_reader.py`           | IBM Docling — tables, complex PDFs (added Mar 2026 #6981) |
| `S3Reader`                    | `s3_reader.py`                | S3 objects (single-blob path)                             |

A `ReaderFactory` lazy-imports readers and maps file extensions:

- `.pdf → pdf`, `.csv → csv`, `.xlsx/.xls → excel`, `.docx/.doc → docx`, `.pptx → pptx`, `.json → json`, `.md/.markdown → markdown`, `.txt → text`
- URL host dispatch: `youtube.com / youtu.be → youtube`, otherwise `website`
- Unknown extension → `text`

Reader base:

```python
@dataclass
class Reader:
    chunk: bool = True
    chunk_size: int = 5000
    separators: Optional[List[str]] = None
    chunking_strategy: Optional[ChunkingStrategy] = None
    name: Optional[str] = None
    description: Optional[str] = None
    max_results: int = 5
    encoding: Optional[str] = None
    # def read(self, obj, name=None, password=None) -> List[Document]
    # async def async_read(...): ...
    # async def chunk_documents_async(...): ...
```

Crucially, **chunking is reader-scoped, not Knowledge-scoped.** A reader carries its own `chunking_strategy`, `chunk_size`, and `separators`. PR #7212 (Mar 2026) explicitly fixed `chunk_size` propagation to default strategies — implying the fan-out had been buggy before that.

### 3.2 Vector DBs (18)

`libs/agno/agno/vectordb/` ships these backends:

`Cassandra`, `Chroma`, `Clickhouse`, `Couchbase`, `LanceDb`, `LangchainDb` (LangChain VectorStore adapter), `LightRAG`, `LlamaIndex` (LlamaIndex VectorStoreIndex adapter), `Milvus`, `MongoDB`, `PgVector`, `Pinecone`, `Qdrant`, `Redis`, `SingleStore`, `SurrealDB`, `UpstashDB`, `Weaviate`.

All implement `VectorDb(ABC)` which mandates 22 methods:

```
create, async_create
name_exists, id_exists, content_hash_exists
insert, async_insert
upsert, async_upsert
search, async_search
drop, async_drop
exists, async_exists
delete, delete_by_id, delete_by_name,
delete_by_metadata, delete_by_content_id
get_supported_search_types
```

`PgVector.__init__` is a representative concrete signature:

```python
def __init__(
    self,
    table_name: str,
    schema: str = "ai",
    name: Optional[str] = None,
    db_url: Optional[str] = None,
    db_engine: Optional[Engine] = None,
    embedder: Optional[Embedder] = None,
    search_type: SearchType = SearchType.vector,
    ...
)
```

with dispatch:

```python
if   self.search_type == SearchType.vector:  return self.vector_search(...)
elif self.search_type == SearchType.keyword: return self.keyword_search(...)
elif self.search_type == SearchType.hybrid:  return self.hybrid_search(...)
```

**Marketing-vs-source discrepancy.** The docs claim _"25+ vector databases."_ The source directory has **18**. The gap is likely accounted for by treating `LangchainDb` and `LlamaIndex` as "any backend those frameworks support" — but that's a stretch, and a framework consumer should plan against the **18** that have real, idiomatic adapters.

The `agnohq/pgvector:16` Docker image is the recommended local dev setup:

```bash
docker run -d \
  -e POSTGRES_DB=ai -e POSTGRES_USER=ai -e POSTGRES_PASSWORD=ai \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v pgvolume:/var/lib/postgresql/data \
  -p 5532:5432 --name pgvector \
  agnohq/pgvector:16
```

Connection string: `postgresql+psycopg://ai:ai@localhost:5532/ai`.

### 3.3 Embedders (19)

From `libs/agno/agno/knowledge/embedder/`:

`aws_bedrock`, `azure_openai`, `cohere`, `fastembed`, `fireworks`, `google` (Gemini), `huggingface`, `jina`, `langdb`, `mistral`, `nebius`, `ollama`, `openai`, `openai_like` (LiteLLM proxy / OpenAI-API-compatible), `sentence_transformer`, `together`, `vllm`, `voyageai`. Plus `base.py`.

Base:

```python
@dataclass
class Embedder:
    dimensions: Optional[int] = 1536
    enable_batch: bool = False
    batch_size: int = 100
    # abstract: get_embedding, get_embedding_and_usage,
    #           async_get_embedding, async_get_embedding_and_usage
```

The **default** embedder is `OpenAIEmbedder(id="text-embedding-3-small", dimensions=1536)`. When no embedder is supplied to a VectorDb, that's what you get.

### 3.4 Chunkers (8)

`libs/agno/agno/knowledge/chunking/`:

| Strategy   | Class               | When to use                                                                       |
| ---------- | ------------------- | --------------------------------------------------------------------------------- |
| Fixed size | `FixedSizeChunking` | Uniform content, predictable throughput; **the default if no strategy is passed** |
| Recursive  | `RecursiveChunking` | Structured/mixed content, hierarchical separators                                 |
| Document   | `DocumentChunking`  | Preserves sections/pages                                                          |
| Markdown   | `MarkdownChunking`  | Split on `#`/`##` headers                                                         |
| Row        | `RowChunking`       | One row per chunk (CSV/Excel)                                                     |
| Code       | `CodeChunking`      | AST-based, function/class boundaries (added Jan 2026 #5981)                       |
| Semantic   | `SemanticChunking`  | Embedding-similarity breakpoints (uses `chonkie`)                                 |
| Agentic    | `AgenticChunking`   | LLM picks boundaries; can take a `custom_prompt` (added Mar 2026 #7085)           |

```python
class ChunkingStrategy(ABC):
    @abstractmethod
    def chunk(self, document: Document) -> List[Document]: ...

class ChunkingStrategyType(str, Enum):
    AGENTIC_CHUNKER, CODE_CHUNKER, DOCUMENT_CHUNKER, RECURSIVE_CHUNKER,
    SEMANTIC_CHUNKER, FIXED_SIZE_CHUNKER, ROW_CHUNKER, MARKDOWN_CHUNKER
```

`SemanticChunking` is the most-tunable, with 13 keyword args including `similarity_threshold=0.5`, `similarity_window=3`, `min_sentences_per_chunk=1`, `filter_polyorder=3` (Savitzky-Golay smoothing on the similarity signal). It defaults to `OpenAIEmbedder` if none supplied.

`AgenticChunking` defaults to `OpenAIChat(DEFAULT_OPENAI_MODEL_ID)` and accepts `max_chunk_size` plus `custom_prompt`. Useful when documents have meaningful structure that fixed-size splitting destroys (regulatory filings, legal contracts), expensive otherwise.

### 3.5 Rerankers (5)

`libs/agno/agno/knowledge/reranker/`:

- `CohereReranker` — default `model="rerank-multilingual-v3.0"`, takes `api_key`, `top_n`.
- `SentenceTransformerReranker` — local cross-encoder. PR #6638 (Mar 2026) fixed a VRAM leak by explicitly releasing the model.
- `AwsBedrockReranker` — Bedrock-hosted rerankers.
- `InfinityReranker` — Infinity inference server (self-hosted).
- `Reranker` (base).

Rerankers attach at the VectorDb layer, **not** at the Knowledge layer:

```python
vector_db = PgVector(
    table_name="docs", db_url=db_url,
    search_type=SearchType.hybrid,
    reranker=CohereReranker(model="rerank-v3.5", top_n=10),
)
```

The reranker fires after retrieval, before results return to `Knowledge.search` / the agent's tool call. The docs only show end-to-end examples with Cohere; the others are present in source but undocumented in cookbook depth.

---

## 4. Search Semantics

### 4.1 Three search modes

```python
class SearchType(str, Enum):
    vector  = "vector"
    keyword = "keyword"
    hybrid  = "hybrid"
```

`search_type` lives on the **VectorDb instance**, not on Knowledge. Knowledge.search accepts a per-call `search_type` override but defaults to whatever the backend was constructed with. Not every backend advertises all three — `VectorDb.get_supported_search_types()` is the runtime accessor.

### 4.2 Hybrid = RRF

From the official hybrid-search page, verbatim:

> "Hybrid search runs two searches in parallel:
>
> 1. Vector search finds semantically similar content (meaning-based)
> 2. Keyword search finds exact term matches (text-based)
> 3. Fusion combines results using Reciprocal Rank Fusion (RRF)"
>
> `RRF(d) = Σ 1/(k + rank)`

The default `hybrid_rrf_k = 60`. Higher `k` smooths rankings; lower `k` makes the top-1 of each branch dominant. The docs explicitly note "Not all vector databases support hybrid search or RRF" — the confirmed list is **PgVector, ChromaDB, LanceDB, Weaviate, Milvus, Pinecone**.

A real LanceDB-side gotcha surfaced by community aggregators: LanceDB's hybrid path _was_ merging vector and FTS results **without deduplication**, so a document hitting both branches could appear twice. Worth checking against your Agno version before relying on top-N counts.

### 4.3 Filters

Filters work at three scopes:

```python
# 1. Agent-level (applies every run)
agent = Agent(knowledge=kb, search_knowledge=True,
              knowledge_filters={"user_id": "jordan_mitchell"})

# 2. Per-call override
agent.print_response("...", knowledge_filters={"document_type": "cv"})

# 3. Direct on Knowledge
results = knowledge.search(query="...",
    filters={"user_id": "jordan_mitchell", "year": 2025})
```

Multiple filters AND together. Filter expressions support `EQ / GT / LT / IN` comparison ops and `AND / OR / NOT` logical ops (via `FilterExpr`). Use `Knowledge.validate_filters(...)` to detect invalid keys — invalid filters are gracefully ignored with warnings rather than erroring. There's also an opt-in **agentic** mode:

```python
agent = Agent(knowledge=kb, search_knowledge=True,
              enable_agentic_knowledge_filters=True)
```

which lets the agent extract filter values from the user's prompt itself.

---

## 5. Agentic RAG vs Traditional RAG

This is where Agno's mental model diverges most clearly from naive RAG implementations. **Two flags on `Agent` decide everything:**

| Flag                                                         | Effect                                                                                                            | "RAG style"         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| `search_knowledge=True` (default when knowledge is provided) | Agent gets a `search_knowledge_base(query)` **tool**; it decides when to call it, can rephrase, can chain queries | **Agentic RAG**     |
| `add_knowledge_to_context=True`                              | Before every model call, Agno auto-injects retrieved references into the prompt                                   | **Traditional RAG** |
| Both true                                                    | Auto-inject _and_ a tool — works but redundant                                                                    | (rare)              |
| Both false                                                   | Knowledge is loaded but the agent never sees it unless you wire something custom                                  | (testing)           |

In Agno's framing, _agentic_ means the LLM strategically chooses to retrieve, can rephrase its query for better recall, and can iterate retrieve→evaluate→re-retrieve loops. The cookbook example uses LanceDB hybrid + Cohere reranker + Claude:

```python
knowledge = Knowledge(
    vector_db=LanceDb(
        uri="tmp/lancedb", table_name="agno_docs",
        search_type=SearchType.hybrid,
        embedder=OpenAIEmbedder(id="text-embedding-3-small"),
        reranker=CohereReranker(model="rerank-multilingual-v3.0"),
    ),
)
agent = Agent(model=OpenAIResponses(id="gpt-5.2"), knowledge=knowledge, markdown=True)
knowledge.insert(name="Agno Docs", url="https://docs.agno.com/introduction.md")
agent.print_response("What are Agno's key features?")
```

The traditional variant is structurally identical but flips the flags:

```python
agent = Agent(model=OpenAIResponses(id="gpt-5.2"),
              knowledge=knowledge,
              add_knowledge_to_context=True,    # auto-inject
              search_knowledge=False)            # no tool
```

Which is better? The community evidence is mixed. Agentic RAG wins when queries are ambiguous or multi-hop (the agent can refine); traditional RAG wins when latency matters and the user query is already specific (one retrieval, one model call). The third-party "12 RAG benchmarks" piece concludes that _when the model, embeddings, retriever, and tools are held constant, accuracy differences across frameworks collapse to zero_ — the real differences are orchestration overhead and token efficiency, not answer quality.

---

## 6. AgentOS Knowledge Plane

AgentOS is the FastAPI runtime. Knowledge is one of the things it knows how to expose.

### 6.1 Auto-discovery + explicit list

```python
class AgentOS:
    def __init__(
        self,
        id=None, name=None, description=None, version=None,
        db: Optional[Union[BaseDb, AsyncBaseDb]] = None,
        agents: Optional[List[Union[Agent, RemoteAgent, ...]]] = None,
        teams: Optional[List[Union[Team, RemoteTeam, ...]]] = None,
        workflows: Optional[List[Union[Workflow, ...]]] = None,
        knowledge: Optional[List[Knowledge]] = None,
        ...
    )
```

Initialization walks every passed agent/team/workflow, harvests its `knowledge` attribute, **unions** that with the explicit `knowledge=[...]` list, and stores the result as `self.knowledge_instances`. So a Knowledge instance can reach the API in two ways: attached to an agent, or as an orphan in the explicit list (useful for read-only references nobody owns).

`get_app()` then mounts:

```python
get_knowledge_router(knowledge_instances=self.knowledge_instances)
```

### 6.2 The 12 routes

All under `/knowledge/*`, no router prefix, every route gated by `Depends(get_authentication_dependency(settings))`:

| Method | Path                                                  | Operation                            |
| ------ | ----------------------------------------------------- | ------------------------------------ |
| POST   | `/knowledge/content`                                  | Upload a file/text/url content blob  |
| POST   | `/knowledge/remote-content`                           | Register a remote-content source     |
| PATCH  | `/knowledge/content/{content_id}`                     | Edit name/description/metadata       |
| GET    | `/knowledge/content`                                  | Paginated list                       |
| GET    | `/knowledge/content/{content_id}`                     | Single content                       |
| DELETE | `/knowledge/content/{content_id}`                     | Remove one                           |
| DELETE | `/knowledge/content`                                  | Remove all                           |
| GET    | `/knowledge/content/{content_id}/status`              | Status (PROCESSING/COMPLETED/FAILED) |
| POST   | `/knowledge/search`                                   | Run a search query                   |
| GET    | `/knowledge/config`                                   | Discover Knowledge instances         |
| GET    | `/knowledge/{knowledge_id}/sources`                   | List remote sources                  |
| GET    | `/knowledge/{knowledge_id}/sources/{source_id}/files` | Browse remote files                  |

Multi-KB resolution uses `?db_id=...&knowledge_id=...` query params, resolved via `get_knowledge_instance(knowledge_instances, db_id, knowledge_id)`. Each KB gets a **deterministic `knowledge_id`** derived from name + db id + table name, stable across restarts.

Uploads return 202 immediately and run via `BackgroundTasks`:

```python
background_tasks.add_task(
    process_content,
    knowledge, content, reader_id, chunker, chunk_size, chunk_overlap,
)
# inside process_content:
await knowledge._aload_content(content, upsert=False, skip_if_exists=True)
```

That call reaches **into a private method**, `_aload_content`, which is a small smell — the router is breaking encapsulation against the class it's serving. In a greenfield design you'd promote that to a real public method.

### 6.3 Search request shape

`VectorSearchRequestSchema` (POST body to `/knowledge/search`):

```
query: str
db_id, knowledge_id: str
vector_db_ids: List[str]
search_type, max_results
filters, meta
```

Note the `vector_db_ids` plural — a single Knowledge can wrap multiple vector DBs, and the AgentOS search can fan out across them.

### 6.4 Control Plane UI

Beyond the API, there's the **Control Plane UI** at `os.agno.com` — a hosted web app that connects directly to your AgentOS deployment from the browser (no proxy through Agno servers). It exposes content browse/upload/delete and is the visual companion to the routes above. The cookbook example `cookbook/05_agent_os/knowledge/agentos_knowledge.py` is the canonical end-to-end demo and showcases the two-DB pattern:

```python
sync_documents_knowledge = Knowledge(
    vector_db=PgVector(
        db_url=db_url, table_name="agno_knowledge_vectors",
        search_type=SearchType.hybrid,
        embedder=OpenAIEmbedder(id="text-embedding-3-small"),
    ),
    contents_db=sync_documents_db,   # PostgresDb instance
)
sync_knowledge_agent = Agent(
    name="Knowledge Agent", model=OpenAIChat(id="gpt-4o-mini"),
    knowledge=sync_documents_knowledge, search_knowledge=True,
    db=sync_documents_db, enable_user_memories=True,
)
sync_agent_os = AgentOS(
    description="Example app with AgentOS Knowledge",
    agents=[sync_knowledge_agent],
    knowledge=[sync_faq_knowledge],   # orphan KB not bound to any agent
)
app = sync_agent_os.get_app()         # FastAPI app w/ /knowledge/*
```

Note `contents_db` is the same `PostgresDb` instance shared with the agent's session store — one Postgres, two roles.

---

## 7. Cookbook Examples (Verbatim, Annotated)

### 7.1 Basic agentic RAG (Qdrant + hybrid)

`cookbook/07_knowledge/01_getting_started/01_basic_rag.py`:

```python
from agno.agent import Agent
from agno.knowledge.embedder.openai import OpenAIEmbedder
from agno.knowledge.knowledge import Knowledge
from agno.models.openai import OpenAIResponses
from agno.vectordb.qdrant import Qdrant
from agno.vectordb.search import SearchType

knowledge = Knowledge(
    vector_db=Qdrant(
        collection="basic_rag",
        url="http://localhost:6333",
        search_type=SearchType.hybrid,
        embedder=OpenAIEmbedder(id="text-embedding-3-small"),
    ),
)
agent = Agent(
    model=OpenAIResponses(id="gpt-5.2"),
    knowledge=knowledge,
    add_knowledge_to_context=True,
    search_knowledge=False,
)
await knowledge.ainsert(url="https://agno-public.s3.amazonaws.com/recipes/ThaiRecipes.pdf")
agent.print_response("How do I make chicken and galangal in coconut milk soup", stream=True)
```

What to notice: `add_knowledge_to_context=True` + `search_knowledge=False` → **traditional** RAG. The auto-pull happens transparently before every model call.

### 7.2 Agentic chunking + PgVector + async

```python
import asyncio
from agno.knowledge.chunking.agentic import AgenticChunking
from agno.knowledge.knowledge import Knowledge
from agno.knowledge.reader.pdf_reader import PDFReader
from agno.vectordb.pgvector import PgVector

knowledge = Knowledge(
    vector_db=PgVector(table_name="recipes_agentic_chunking",
                       db_url="postgresql+psycopg://ai:ai@localhost:5532/ai"),
)
asyncio.run(knowledge.ainsert(
    url="https://agno-public.s3.amazonaws.com/recipes/ThaiRecipes.pdf",
    reader=PDFReader(name="Agentic Chunking Reader",
                     chunking_strategy=AgenticChunking()),
))
```

What to notice: chunking config travels with the **reader**, not the Knowledge. `AgenticChunking()` with no args spins up `OpenAIChat(DEFAULT_OPENAI_MODEL_ID)` under the hood, which costs real money per ingest.

### 7.3 Metadata filtering at every level

```python
knowledge.insert(path="resumes/",
    metadata={"user_id": "jordan_mitchell", "document_type": "cv", "year": 2025})

# 1. agent-level
agent = Agent(knowledge=knowledge, search_knowledge=True,
              knowledge_filters={"user_id": "jordan_mitchell"})

# 2. query-level override
agent.print_response("What are Jordan's skills?",
                     knowledge_filters={"document_type": "cv"})

# 3. direct
results = knowledge.search(query="programming experience",
    filters={"user_id": "jordan_mitchell", "year": 2025})

# 4. agentic — model extracts filters from the prompt
agent = Agent(knowledge=knowledge, search_knowledge=True,
              enable_agentic_knowledge_filters=True)
```

### 7.4 Chroma + Gemini hybrid

```python
from agno.agent import Agent
from agno.knowledge.embedder.google import GeminiEmbedder
from agno.knowledge.knowledge import Knowledge
from agno.models.google import Gemini
from agno.vectordb.chroma import ChromaDb
from agno.vectordb.search import SearchType

knowledge = Knowledge(
    vector_db=ChromaDb(
        collection="docs", path="tmp/chromadb",
        persistent_client=True,
        search_type=SearchType.hybrid,
        embedder=GeminiEmbedder(id="gemini-embedding-001"),
    ),
)
knowledge.insert(url="https://docs.agno.com/introduction.md", skip_if_exists=True)
agent = Agent(model=Gemini(id="gemini-3-flash-preview"),
              knowledge=knowledge, search_knowledge=True, markdown=True)
agent.print_response("What is Agno?", stream=True)
```

### 7.5 Async batch loading

```python
await asyncio.gather(
    knowledge.ainsert(path="./reports/Q1.pdf"),
    knowledge.ainsert(path="./reports/Q2.pdf"),
    knowledge.ainsert(path="./reports/Q3.pdf"),
    knowledge.ainsert(path="./reports/Q4.pdf"),
)
```

This is the recommended way to ingest many sources at once according to the performance-tips page.

---

## 8. Performance Posture

### 8.1 What Agno claims

From `docs.agno.com/get-started/performance`:

- **Agent instantiation:** ~2 µs average, _~10,000× faster than LangGraph_.
- **Memory footprint:** ~6.6 KiB per agent average. 24× lower than LangGraph, 4× lower than PydanticAI, 10× lower than CrewAI.
- **Methodology:** `tracemalloc`, 1000 runs, Apple M4 MacBook Pro, October 2025.
- **Agno's own caveat:** _"you should run the evaluation yourself on your own machine and should not take these results at face value."_

### 8.2 What the criticism is

The HN thread for the original "10,000× faster" launch contained substantive pushback. User `tomnipotent`: _"This '10,000x' faster claim is specific to how long it takes to instantiate a client object, before actually interacting with it. It's a silly claim that doesn't hold up to scrutiny and detracts from your project."_ User `mpalmer`: _"It's like claiming a car is faster based on ignition speed."_ A subsequent Medium post argued that **inference cost dominates the bill anyway** — even a 10,000× faster instantiation is irrelevant if the dominant axis is tokens-per-task.

For Knowledge specifically: **no µs/ms numbers surface in the docs.** The performance-tips page is qualitative — vector DB sizing, `skip_if_exists`, chunking trade-offs, async batch loading. No third-party retrieval-quality benchmark for Agno surfaced in the search (no RAGAS scores, no faithfulness comparisons against LangChain/LlamaIndex with controlled inputs).

### 8.3 Practical guidance from the docs

| Vector DB          | Recommended scale          | Use case                 |
| ------------------ | -------------------------- | ------------------------ |
| LanceDB / ChromaDB | Dev/testing                | Zero setup, embedded     |
| PgVector           | "Production up to 1M docs" | When you also want SQL   |
| Pinecone           | Managed/auto-scaling       | Don't want to operate it |

Three concrete optimization knobs:

1. **`skip_if_exists=True`** — by far the biggest reingestion speedup. Uses `content_hash` to skip already-indexed items.
2. **Filter before retrieval** — narrowing scope dramatically cuts latency, especially in PgVector where the planner can use a B-tree on metadata before the vector index.
3. **Async batch loading** — `asyncio.gather([knowledge.ainsert(...)])` for parallel ingest.

The chunking trade-off is the usual one:

| Method     | Speed               | Quality                                       |
| ---------- | ------------------- | --------------------------------------------- |
| Fixed Size | Fast                | Good for uniform content                      |
| Recursive  | Fast                | Good for structured docs                      |
| Semantic   | Slower              | Best for complex docs                         |
| Agentic    | Slowest (LLM-bound) | Best when structure matters and budget allows |

---

## 9. Comparison Snapshot

| Axis                   | Agno                                                          | LangChain                             | LlamaIndex                                                | Haystack                        |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Knowledge primitive    | `Knowledge` dataclass with split `vector_db` + `contents_db`  | `VectorStore` + `Retriever` chain     | `VectorStoreIndex` + node parsers                         | `DocumentStore` + `Pipeline`    |
| Vector DB count        | 18 in source (25+ claimed)                                    | 200+ integrations (broadest)          | broad                                                     | broad                           |
| Embedder count         | 19                                                            | broadest                              | broad                                                     | broad                           |
| Ingest API verb        | `insert` / `ainsert`                                          | `add_documents`                       | `from_documents`                                          | `write_documents`               |
| Agentic search         | `search_knowledge=True` adds a tool; default-on               | needs explicit wiring                 | `as_query_engine(use_async=True)`                         | pipeline-shaped                 |
| Hybrid search          | RRF across PgVector/Chroma/LanceDB/Weaviate/Milvus/Pinecone   | backend-specific                      | backend-specific                                          | backend-specific                |
| Reranker               | Cohere/SentenceTransformer/Bedrock/Infinity at VectorDb layer | as a chain step                       | post-processor in query engine                            | pipeline component              |
| Content status machine | First-class (`Content.status`)                                | None                                  | None                                                      | Some via DocumentStore metadata |
| Management API         | AgentOS `/knowledge/*` (12 routes)                            | None native                           | None native                                               | Optional Haystack API           |
| Native observability   | None native (Langfuse/AgentOps third-party)                   | **LangSmith** native, "best-in-class" | LlamaTrace                                                | basic                           |
| Multimodal RAG         | **Open gap** (#5980)                                          | Partial                               | Partial                                                   | Partial                         |
| Notable retrievers     | Hybrid + reranker                                             | broad                                 | **SentenceWindow, AutoMerging, Hierarchical, LlamaParse** | broad                           |

The third-party "12 RAG benchmarks" piece — held constant against the same models, embeddings, retrievers, and tools — concludes that _retrieval accuracy across frameworks collapses to roughly equal_ and that **orchestration overhead** and **token efficiency** are the real differentiators. Take any "X is more accurate than Y" claim with that in mind.

For a TypeScript framework builder looking at Agno for design inspiration, the **distinctive ideas worth copying** are:

1. **Two-DB split** with a `Content.status` machine for ingestion lifecycle.
2. **Flag-pair semantics** (`search_knowledge` vs `add_knowledge_to_context`) — cleaner than a single ambiguous "RAG mode" enum.
3. **Reader-scoped chunking** — chunker travels with reader, not with Knowledge.
4. **Multi-KB AgentOS routing** — auto-discover from agents, allow explicit orphans, deterministic IDs.
5. **`isolate_vector_search`** flag (#6519) — explicit opt-in to cross-KB leakage protection rather than a silent default change.

The **ideas worth skipping** are the private-method reach-around in the AgentOS router (`_aload_content`), the marketing-vs-source count gap (25+ vs 18), and the per-call `search_type` override that papers over a config-on-the-wrong-object decision (search type should logically live on the search call, not the backend instance).

---

## 10. Known Bugs and Open Gaps

These are reproducible in the public issue tracker / source as of search:

### 10.1 `#3126` — chunking_strategy silently ignored (v1.4.5)

> _"the AgentKnowledge component is skipping the provided chunking_strategy and defaulting to FixedSizeChunking in all cases."_

The user had to downgrade. The issue is in the legacy `AgentKnowledge` shape, which the v2.5 refactor (PR #6429) replaced — but the issue remains nominally open and no clean confirmation appears in the changelog.

### 10.2 `#7754` — upsert bails on missing row

`_update_content` / `_aupdate_content` check for an existing row before upserting and bail with a warning if not found. There's already an in-source TODO at `knowledge.py:2528`:

> _"we shouldn't check for content here, we should trust the upsert method to handle conflicts"_

i.e. the maintainer knows the path is wrong. Until fixed, any sync workflow that tries to `patch_content(new_id)` for a never-seen-before id silently no-ops.

### 10.3 `#5980` — multimodal RAG hallucinates

Multimodal tool results (image+text) with GPT-5.2 lead the model to drift or ignore the expected schema. Multimodal RAG was filed as a first-class request in Jan 2026 and remains open. Don't use Agno Knowledge for image-heavy retrieval workflows yet.

### 10.4 LanceDB hybrid dedup

LanceDB hybrid search merges vector + FTS results without deduplication (per third-party aggregator). A document hitting both branches can appear twice in the top-N.

### 10.5 Default model footgun

If you forget `model=...` on Agent, Agno **defaults to OpenAI GPT-4o**. For shops without OpenAI billing this is a surprise charge. Pin your model explicitly.

### 10.6 Observability gap

There's no native equivalent to LangSmith. You instrument via Langfuse, AgentOps, or your own OTel exporter. For a framework that markets on operational excellence, this is the biggest gap relative to the LangChain side.

### 10.7 Benchmarks measure the wrong axis

The 10,000× / 529× / 50× framing measures client object construction, not workload throughput. Plan capacity from your own measurements.

### 10.8 Marketing vs source drift

"25+ vector databases" appears in the README. The actual directory has 18 idiomatic adapters (the LangChain and LlamaIndex _adapters_ would technically expose anything those frameworks support, but that's not the same thing). The same drift exists for embedders. Always grep the source.

---

## 11. Recent Direction of Travel (last ~6 months)

From `gh api repos/agno-agi/agno/commits?path=libs/agno/agno/knowledge`:

| Month   | Theme                                  | Notable commits                                                                                                                                                                                                               |
| ------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-01 | Cloud sources + chunking expansion     | CodeChunking AST-based (#5981); Azure Blob (#6120); Excel reader (#6129); Knowledge remote support (#6106)                                                                                                                    |
| 2026-02 | v2.5 refactor + isolation flag         | Phase 1 Agent/Team refactor (#6429, key); `isolate_vector_search` (#6519); cloud storage browsing (#6584); FastEmbed cache + reader reset (#6029); PDF content sanitization (#6591); SentenceTransformer VRAM cleanup (#6638) |
| 2026-03 | Readers + agentic prompts + GitHub App | Docling reader (#6981); AgenticChunking `custom_prompt` (#7085); GitHub App auth (#6831); chunk_size propagation fix (#7212)                                                                                                  |
| 2026-04 | LLMsTxt + remote identity              | LLMsTxtReader (#7458); SAS auth for Azure Blob (#7247); remote source identity in content_hash (#7515); per-request GitHubConfig repo (#7496)                                                                                 |
| 2026-05 | Hardening                              | SSRF `allowed_hosts` allowlist for knowledge readers (#7892); LLMsTxtTools allowlist (#7759); Gemini connector header (#7828)                                                                                                 |

The arc: **breadth of sources, then security hardening, then readiness for cross-tenant deployment.** SSRF guards and content-hash identity scoping point at multi-tenant SaaS use cases — likely tied to Agno's own hosted offerings.

---

## 12. Synthesis & Insights

### 12.1 What Agno's Knowledge gets right

- **Lifecycle as a first-class concept.** The `Content.status` machine treats ingestion as a real process with intermediate states, not a single atomic write. Most agent frameworks don't model this, and it's exactly what you need for a UI that can show "12 of 47 documents still processing."
- **Default-on agentic RAG.** When you attach `knowledge=...` to an Agent, the agent gets a search tool by default. That sets the right expectation: the LLM is in the loop on retrieval.
- **AgentOS multi-KB routing.** Auto-discovery + explicit orphan list + deterministic IDs is a clean design. No magic, no global registry, no `Knowledge.register_globally()`.
- **Reader-scoped chunking.** Chunkers travel with readers, which is correct: PDF chunking and Markdown chunking really are different problems, and pinning chunking to the source format is sane.

### 12.2 What it gets messy

- **`Knowledge.search` accepts a per-call `search_type` override**, but the backend's constructor-time `search_type` is still the default. Two places to set the same knob is a smell — the live argument should win unambiguously.
- **`_aload_content` is private but called from the AgentOS router.** Either the method should be public, or the router should call a public surface. As-is, refactoring the private method silently breaks the router contract.
- **Two TODOs that are bugs**, not aspirations (the upsert bail, the chunking-strategy drop).
- **Hybrid-search support varies per backend, but `SearchType.hybrid` is a single enum value.** You can construct a `SingleStore(search_type=SearchType.hybrid)` and only discover at runtime that the backend doesn't support it. `get_supported_search_types()` is the workaround, but it would be cleaner to make hybrid support a typed capability.
- **The 25+/18 drift** suggests the maintainers prioritize marketing breadth over public-doc accuracy. For a framework consumer, that means: always validate against `libs/agno/agno/vectordb/`, never the README.

### 12.3 What this means for a parallel TS framework

If you're building a similar primitive in TypeScript:

1. **Don't collapse `vector_db` and `contents_db`.** They have different scaling characteristics (vector store is write-heavy chunks, content store is read-heavy metadata), and separating them buys you status visibility, edit-without-reembed, and deletion sync. The cost of keeping them in sync is real but tractable.

2. **Default-on agentic RAG is a strong opinion worth taking.** It's simpler to teach ("the agent has a search tool") than "configure the retrieval mode." Make the auto-injection variant explicit opt-in.

3. **Pin chunking to readers.** Don't put chunking config on the Knowledge object. The right chunker depends on the format, and a Knowledge that holds PDFs + Markdown + JSON wants different chunkers per type.

4. **Make hybrid support a typed capability, not a runtime flag.** TypeScript can express this cleanly via discriminated unions / branded types — `PgVector implements HybridCapable`, `Cassandra implements VectorOnly`. Constructing a vector-only backend with `searchType: "hybrid"` should be a compile error.

5. **Treat the management plane as a separate surface from the agent surface.** Agno's `AgentOS(knowledge=[...])` shape — auto-discover from attached agents, allow explicit orphans, mount as a router — is the right factoring. Mirror it.

6. **Watch the multi-tenant primitives.** The 2026-05 SSRF and content-hash-identity changes show that going from "open-source toy" to "hosted offering" forces hardening choices a single-tenant framework can defer. If you plan to ever host the framework, build the allowlist and source-identity affordances early.

### 12.4 Open questions worth tracking

- **Will the upsert-bail TODO get fixed?** If not, semantic versioning is going to bite users who upgrade past it.
- **Does multimodal RAG land before the next major release?** Open since Jan 2026; if it slips past v3, it'll be a long-term gap.
- **Will Agno publish a real retrieval-quality benchmark?** All current performance claims are about instantiation. If the Knowledge layer never gets a credibility-tier benchmark, the marketing-vs-substance gap stays.
- **Is the LangchainDb / LlamaIndex adapter healthy?** It's the only realistic path to the "25+" headline number, and adapters in fast-moving ecosystems break quietly.

---

## 13. Limitations & Caveats

- **Repository state captured at search time.** `agno-agi/agno` ships multiple releases per week; the directory counts and commit list reflect ~2026-05-15. Reverify before depending on a specific feature.
- **No independent benchmark of Agno's Knowledge retrieval quality** surfaced in the research. Every quoted performance number is Agno's own.
- **Some doc pages 404.** `/knowledge/concepts/search-and-retrieval/rerankers` and `/reference/knowledge` are stubs or missing. Source code is the fallback.
- **Community evidence is thin in some channels.** Reddit `r/LocalLLaMA` returned almost no first-party Agno threads. Most external commentary is on HN, Medium, and Substack — which skews toward enthusiasts and critics, not real production operators.
- **Marketing-vs-source drift** for vector DB and embedder counts. Cited as "claimed N / actually M" rather than picking a single number.
- **Some Agno-specific bug claims trace back through community aggregators** (`zread.ai/agno-agi`) rather than first-party reports. They are flagged in evidence with lower confidence (0.75) and labeled accordingly in §10.

---

## 14. Recommendations

If you're a **framework builder** comparing primitives:

- Read `libs/agno/agno/knowledge/knowledge.py`, `vectordb/base.py`, and `os/routers/knowledge/knowledge.py` directly. The whole architecture fits in three files.
- Copy the two-DB split and the `Content.status` machine. Skip the AgentOS private-method reach-around.

If you're an **engineer evaluating Agno for production RAG**:

- Use it for **dev/testing rapidly** — `Knowledge(vector_db=Chroma(...))` is one line and works.
- For production, prefer **PgVector with `contents_db: PostgresDb`**. Test against your own dataset for retrieval quality.
- Pin your model and embedder explicitly. Don't rely on defaults.
- If you need observability, wire **Langfuse** or **AgentOps** from day one.
- Avoid multimodal-heavy RAG until #5980 lands.

If you're a **researcher** writing about agent frameworks:

- The "Agno is 10,000× faster" framing is widely contested; cite it as a claim, not a fact.
- Independent retrieval benchmarks comparing Agno to LangChain/LlamaIndex with controlled inputs would be a real contribution — none exist in the current literature.

---

## 15. Methodology Appendix

**Pipeline:** Standard 8-phase, run in **deep** mode.

- **Phase 1 (SCOPE):** Decomposed "everything about Agno AI Knowledge" into 11 angles: framework context, architecture, ingestion, retrieval, storage backends, embedders, RAG modes, AgentOS integration, examples, comparison, limitations.
- **Phase 2 (PLAN):** One canonical-URL WebFetch + 8 WebSearches + 3 Agent subagents (source, docs, community), parallel.
- **Phase 3 (RETRIEVE):** Single message dispatched everything concurrently. Total wall time ~6 minutes for the initial batch, ~10 minutes including the targeted WebFetch follow-ups.
- **Phase 4 (TRIANGULATE):** Every major architectural claim has 2-3 independent sources: source-code subagent + docs subagent + (sometimes) community/critical subagent. Discrepancies flagged inline (e.g. 18 vector DBs in source vs 25+ in marketing).
- **Phase 4.5 (OUTLINE REFINEMENT):** Added §6 (AgentOS plane) as a standalone section once it became clear it's distinctive enough to merit one. Added §10 (Bugs and gaps) because the community evidence surfaced concrete, code-traceable issues worth their own section. Demoted detailed embedder/vectordb subpage tables since the directory listings + one Docker recipe gave enough.
- **Phase 5 (SYNTHESIZE):** §12 connects the architectural choices to design recommendations for a parallel TS framework.
- **Phase 6 (CRITIQUE):** Red-team check — flagged the marketing-vs-source drift, the missing independent benchmarks, the private-method router smell, and the per-call/per-instance `search_type` duplication. Persona checks ("would a Python dev migrating from LangChain trust this?" yes; "would an SRE deploying multi-tenant Agno trust this?" mostly, with caveats around the multi-tenant work being recent).
- **Phase 7 (REFINE):** Cross-checked the AgentOS router endpoint list against both the source-code subagent count (12) and the docs paraphrase — they match. Confirmed RRF formula across three sources (hybrid-search page WebFetch, two search-result paraphrases).
- **Phase 8 (PACKAGE):** This document plus `sources.jsonl`, `evidence.jsonl`, `run_manifest.json`.

**Confidence floor:** 0.55. Anything below was excluded or surfaced as "claimed by aggregator." Items at 0.75 (zread.ai LanceDB dedup) are reported but explicitly labeled as third-party aggregator-sourced.

**Total source count:** 40 distinct sources across docs, source code, community blogs, GitHub issues, HN threads, and the Agno marketing site.

---

## 16. Bibliography

### Primary — Agno documentation

1. [Agno Knowledge — AgentOS Examples Overview](https://docs.agno.com/examples/agent-os/knowledge/overview)
2. [Agno — Knowledge Concepts / Readers Overview](https://docs.agno.com/knowledge/concepts/readers/overview)
3. [Agno — Hybrid Search](https://docs.agno.com/knowledge/concepts/search-and-retrieval/hybrid-search)
4. [Agno — Agentic RAG with Hybrid Search and Reranking](https://docs.agno.com/basics/knowledge/search-and-retrieval/usage/agentic-rag)
5. [Agno — Performance Tips](https://docs.agno.com/knowledge/concepts/performance-tips)
6. [Agno — Contents DB](https://docs.agno.com/knowledge/concepts/contents-db)
7. [Agno — Embedders Overview](https://docs.agno.com/knowledge/concepts/embedder/overview)
8. [Agno — Chunking Overview](https://docs.agno.com/knowledge/concepts/chunking/overview)
9. [Agno — Vector DB Concepts](https://docs.agno.com/knowledge/concepts/vector-db)
10. [Agno — Agents with Knowledge](https://docs.agno.com/knowledge/agents/overview)
11. [Agno — Filters Overview](https://docs.agno.com/knowledge/concepts/filters/overview)
12. [Agno — AgentOS Manage Knowledge](https://docs.agno.com/agent-os/knowledge/manage-knowledge)
13. [Agno — AgentOS Filter Knowledge](https://docs.agno.com/agent-os/knowledge/filter-knowledge)
14. [Agno — Performance benchmarks](https://docs.agno.com/get-started/performance)
15. [Agno — AgentOS marketing](https://www.agno.com/agentos)
16. [Introducing Agno — Ashpreet Bedi](https://www.ashpreetbedi.com/articles/introducing-agno)

### Primary — Source code

17. [agno-agi/agno GitHub repo](https://github.com/agno-agi/agno)
18. [Source: knowledge.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/knowledge.py)
19. [Source: vectordb/search.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/vectordb/search.py)
20. [Source: chunking/strategy.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/chunking/strategy.py)
21. [Source: chunking/agentic.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/chunking/agentic.py)
22. [Source: chunking/semantic.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/chunking/semantic.py)
23. [Source: knowledge/content.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/content.py)
24. [Source: os/routers/knowledge/knowledge.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/os/routers/knowledge/knowledge.py)
25. [Source: knowledge/reader/reader_factory.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/reader/reader_factory.py)
26. [Source: knowledge/reranker/cohere.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/knowledge/reranker/cohere.py)
27. [Source: vectordb/pgvector/pgvector.py](https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/vectordb/pgvector/pgvector.py)
28. [Cookbook: 01_basic_rag.py](https://raw.githubusercontent.com/agno-agi/agno/main/cookbook/07_knowledge/01_getting_started/01_basic_rag.py)
29. [Cookbook: agentos_knowledge.py](https://raw.githubusercontent.com/agno-agi/agno/main/cookbook/05_agent_os/knowledge/agentos_knowledge.py)

### Community / Critical

30. [HN — Agno: Agent framework 10,000x faster than LangChain](https://news.ycombinator.com/item?id=43274435)
31. [Medium — Agno is selling you infrastructure (Alvis Ng)](https://medium.com/@iamalvisng/agno-is-selling-you-infrastructure-your-problem-isnt-yet-c8a28fdb1cd4)
32. [ZenML Blog — Agno vs LangGraph](https://www.zenml.io/blog/agno-vs-langgraph)
33. [Medium (Devi) — Agentic Framework Deep Dive: Agno](https://medium.com/@devipriyakaruppiah/agentic-framework-deep-dive-series-part-2-agno-c45da579b7c0)
34. [Medium (Sharath Pai) — Agentic RAG with MongoDB and Agno](https://medium.com/@sharathpai107/performing-agentic-rag-with-mongodb-and-agno-010ceef5141b)
35. [DigitalOcean — Understanding Agno](https://www.digitalocean.com/community/conceptual-articles/agno-fast-scalable-multi-agent-framework)
36. [DeepWiki — agno-agi/agno overview](https://deepwiki.com/agno-agi/agno)
37. [zread.ai — Agno issues and feedbacks aggregator](https://zread.ai/agno-agi/agno/6-issues-and-feedbacks)

### Issues

38. [Issue #3126 — chunking_strategy ignored](https://github.com/agno-agi/agno/issues/3126)
39. [Issue #5980 — multimodal RAG feature request](https://github.com/agno-agi/agno/issues/5980)
40. [Issue #7754 — upsert bails on missing row](https://github.com/agno-agi/agno/issues/7754)

---

_Evidence files: `sources.jsonl`, `evidence.jsonl`, `run_manifest.json` in the same directory._
