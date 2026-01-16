# Whitepaper and Research Paper References

This document catalogs academic papers that back up the implementations in the DeepAgents codebase.

---

## Text2SQL Synthesis Module

Papers backing implementations in `packages/text2sql/src/lib/synthesis/`.

### Evolution Strategies

#### WizardLM: Evol-Instruct (ICLR 2024)

- **arXiv:** [2304.12244](https://arxiv.org/abs/2304.12244)
- **Authors:** Can Xu et al.
- **Backs:**
  - `synthesizers/depth-evolver.ts` - In-depth evolution (add constraints, deepening, increased reasoning steps, complicating input)
  - `synthesizers/breadth-evolver.ts` - In-breadth evolution (paraphrasing for topic/skill coverage, diversity)
- **Key contribution:** Proposes Evol-Instruct method with two evolution types: in-depth (making instructions more complex) and in-breadth (enhancing diversity). Uses instruction eliminator to filter failed evolutions.

### Communication Styles

#### OmniSQL (March 2025)

- **arXiv:** [2503.02240](https://arxiv.org/html/2503.02240)
- **Backs:** `synthesizers/styles.ts`
- **Key contribution:** Defines 9 linguistic styles for text-to-SQL question generation: formal, colloquial, imperative, interrogative, descriptive, concise, vague, metaphorical, conversational.

### SQL Complexity Taxonomy

#### Spider: Complex Cross-Domain Semantic Parsing (EMNLP 2018)

- **arXiv:** [1809.08887](https://arxiv.org/abs/1809.08887)
- **Authors:** Tao Yu et al. (Yale)
- **Backs:** `agents/question.agent.ts` - 4-level complexity classification
- **Key contribution:** Introduces SQL difficulty levels (easy, medium, hard, extra hard) based on query complexity. Dataset of 10,181 questions across 200 databases.

#### Beyond SELECT: Comprehensive Taxonomy-Guided Benchmark (2024)

- **arXiv:** [2511.13590](https://arxiv.org/abs/2511.13590)
- **Backs:** SQL complexity classification approach
- **Key contribution:** Novel taxonomy based on core intents, statement types, syntax structures, and key actions. Introduces SQL-Synth pipeline for taxonomy-guided dataset synthesis.

### Real-World Database Benchmarks

#### BIRD: Large-Scale Database Grounded Text-to-SQL (NeurIPS 2023)

- **arXiv:** [2305.03111](https://arxiv.org/abs/2305.03111)
- **Authors:** Jinyang Li et al.
- **Backs:** Handling dirty/noisy database values, external knowledge evidence
- **Key contribution:** 12,751 text-to-SQL pairs across 95 databases (33.4 GB), 37 professional domains. Addresses: large dirty database values, external knowledge, SQL execution efficiency.

### Multi-Turn Conversational Context

Papers backing implementations in `packages/text2sql/src/lib/synthesis/extractors/`.

#### SParC: Cross-Domain Semantic Parsing in Context (ACL 2019)

- **URL:** [yale-lily.github.io/sparc](https://yale-lily.github.io/sparc)
- **Authors:** Tao Yu et al. (Yale/Salesforce)
- **Backs:** Context-dependent multi-turn parsing approach
- **Key contribution:** 4,298 question sequences (12k+ questions) with SQL annotations across 200 databases. Context-dependent version of Spider.

#### CoSQL: Conversational Text-to-SQL (EMNLP 2019)

- **arXiv:** [1909.05378](https://arxiv.org/abs/1909.05378)
- **Authors:** Tao Yu et al.
- **Backs:** `extractors/full-context-extractor.ts`, `extractors/windowed-context-extractor.ts`
- **Key contribution:** 3,007 dialogues (30k+ turns, 10k SQL queries) with dialogue acts. Wizard-of-Oz collection simulating real DB query scenarios.

#### DELTA: Decoupled Dialogue Modeling for Multi-Turn Text-to-SQL

- **arXiv:** [2106.02282](https://arxiv.org/abs/2106.02282)
- **Backs:** `extractors/base-contextual-extractor.ts` - Context-to-standalone reformulation
- **Key contribution:** Decouples dialogue understanding from semantic parsing. Uses pretrained BART for utterance rewriting to resolve co-reference and ellipsis.

#### CoE-SQL: Chain-of-Editions for Multi-Turn Text-to-SQL (2024)

- **arXiv:** [2405.02712](https://arxiv.org/abs/2405.02712)
- **Backs:** Incremental SQL modification from prior queries
- **Key contribution:** In conversational context, current SQL can be modified from preceding SQL with only a few operations due to context dependency.

#### Pay More Attention to History (2021)

- **arXiv:** [2112.08735](https://arxiv.org/abs/2112.08735)
- **Backs:** Context modeling strategy for extractors
- **Key contribution:** Explicitly modeling semantic changes by adding each turn and summarization of whole context improves multi-turn semantic parsing.

### Topic Segmentation

#### Multi-Granularity Prompts for Topic Shift Detection (2023)

- **arXiv:** [2305.14006](https://arxiv.org/abs/2305.14006)
- **Backs:** `extractors/segmented-context-extractor.ts` - LLM-based topic change detection
- **Key contribution:** Prompt-based approach to extract topic information at multiple granularities (label, turn, topic level). Tested on TIAGE benchmark.

#### TIAGE: Topic-Shift Aware Dialog Benchmark

- **Backs:** `extractors/segmented-context-extractor.ts` - Topic-aware context segmentation
- **Key contribution:** Benchmark for topic-shift detection, topic-shift triggered response generation, and topic-aware dialog generation.

### Synthetic Data Generation

#### SQL-GEN: Dialect-Agnostic Text-to-SQL Synthesis (August 2024)

- **arXiv:** [2408.12733](https://arxiv.org/abs/2408.12733)
- **Backs:** `synthesizers/schema-synthesizer.ts` - Schema-driven synthetic pair generation
- **Key contribution:** Dialect-agnostic method for generating synthetic Text-to-SQL pairs. Expands SQL templates using LLMs with in-context learning.

---

## Agent Planning Patterns

Papers backing implementations in `packages/agent/src/lib/patterns/`.

### Plan-and-Act Framework

- **Location:** `packages/agent/src/lib/patterns/plan_and_act/plan_and_act.ts:162`
- **Context:** Implementation of the Plan-and-Act framework that separates high-level planning from low-level execution with dynamic replanning.

### Plan-and-Solve Framework

- **Location:** `notes/planning.md:13-21` and `packages/orchestrator/src/lib/deepplan/plan-and-solve.ts`
- **Context:** A formal design pattern consisting of user message, planner agent, executor agent, and replanner agent components.

### LLM Compiler

- **Location:** `packages/orchestrator/src/lib/deepresearch.v1.ts:309`
- **Context:** Mentioned as one of the planning modules from whitepapers to integrate into the deepresearch agent.

---

## Other References

### CLIP Paper (arXiv:2103.00020)

- **URL:** https://arxiv.org/pdf/2103.00020.pdf
- **Location:** `packages/orchestrator/src/lib/arxiv/arxiv.ts:141`
- **Context:** Used as an example/demo URL in the arXiv research assistant agent.

---

## Summary Table

| Paper                     | arXiv      | Year | Backs                                |
| ------------------------- | ---------- | ---- | ------------------------------------ |
| WizardLM (Evol-Instruct)  | 2304.12244 | 2023 | depth-evolver.ts, breadth-evolver.ts |
| OmniSQL                   | 2503.02240 | 2025 | styles.ts                            |
| Spider                    | 1809.08887 | 2018 | SQL complexity levels                |
| Beyond SELECT             | 2511.13590 | 2024 | SQL taxonomy                         |
| BIRD                      | 2305.03111 | 2023 | Real-world DB handling               |
| SParC                     | -          | 2019 | Multi-turn context                   |
| CoSQL                     | 1909.05378 | 2019 | Conversational text2sql              |
| DELTA                     | 2106.02282 | 2021 | Context reformulation                |
| CoE-SQL                   | 2405.02712 | 2024 | Chain-of-editions                    |
| Multi-Granularity Prompts | 2305.14006 | 2023 | Topic shift detection                |
| SQL-GEN                   | 2408.12733 | 2024 | Schema-driven synthesis              |

/\*\*

- Chain of Thought prompt for text-to-SQL.
-
- Research-backed approach:
- - Keep reasoning concise to avoid error propagation (EMNLP 2023)
- - Focus on schema linking and database operations (Struct-SQL 2025)
- - Use intermediate representations for complex queries
-
- @see https://arxiv.org/abs/2305.14215
- @see https://arxiv.org/html/2512.17053
  \*/
