# ph-brain-engine

[![CI](https://github.com/PhelipeHonesto/ph-brain-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/PhelipeHonesto/ph-brain-engine/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-22_passing-brightgreen)
![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)
![pgvector](https://img.shields.io/badge/pgvector-2048d-4169E1?logo=postgresql&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-4_tools-111111)

**Long-term memory for agents.** ph-brain-engine turns a markdown vault (notes, Claude conversation exports, project docs) into a hybrid semantic and keyword search index. Any MCP client, like Claude Code, can query it mid-task.

The retrieval core (recursive chunker, rank fusion, dedup, intent classifier) is ported from [GBrain](https://github.com/garrytan/gbrain) under the MIT License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Postgres and pgvector engine, the Voyage embedding pipeline, the importer, the CLI, and the MCP server were built here.

## What this is

A small TypeScript + Bun service that ingests a markdown vault, embeds every
chunk with Voyage AI's `voyage-3-large` at 2048 dimensions, stores pages and
vectors in Supabase Postgres with pgvector, and exposes hybrid semantic +
keyword search over an MCP stdio server so Claude Code can query your brain.

Phase 1 gets retrieval working end-to-end. Phase 2 adds a dream cycle,
enrichment, and automated sync.

## Prerequisites

- [Bun](https://bun.sh/) (runtime)
- A Supabase project with the `vector`, `pg_trgm`, and `pgcrypto` extensions
  (the schema will enable them on apply)
- A [Voyage AI](https://www.voyageai.com/) API key
- `psql` on your PATH if you want to run `scripts/apply-schema.sh` (optional;
  `bun run src/cli.ts init-schema` works too)

## Setup

```bash
bun install
cp .env.example .env
# fill in DATABASE_URL and VOYAGE_API_KEY

# apply schema
bun run schema           # or: bun run src/cli.ts init-schema

# ingest your vault
bun run src/cli.ts import ~/PH-Brain/sources

# query from the CLI
bun run src/cli.ts query "charter brokerage operating model"

# stats
bun run src/cli.ts stats
```

## Wiring the MCP server into Claude Code

Add this to your Claude Code MCP config (the exact path depends on the client;
for Claude Code CLI it is `~/.claude/mcp_servers.json` or a per-project
equivalent):

```json
{
  "mcpServers": {
    "ph-brain": {
      "command": "bun",
      "args": ["run", "/path/to/ph-brain-engine/src/cli.ts", "serve"],
      "env": {
        "DATABASE_URL": "postgres://...",
        "VOYAGE_API_KEY": "pa-..."
      }
    }
  }
}
```

Then from any Claude Code session you will have four tools available:

- `search` — hybrid semantic + keyword search with per-chunk scores
- `get_page` — fetch full body + frontmatter for a slug
- `list_pages` — list pages filtered by `source_type`
- `stats` — counts and source-type breakdown

## How retrieval works

```
query ──► embed as "query" ──┐
                             ├─► RRF fusion (K=60)
keyword (websearch_to_tsquery)┘
                             │
                             ▼
                   normalize scores to 0-1
                             │
                             ▼
                  cosine re-score blend
                  (0.7 × RRF + 0.3 × cosine)
                             │
                             ▼
                   4-layer dedup pipeline
                             │
                             ▼
                        top N chunks
```

The `expandedQueries` parameter on `hybridSearch()` is reserved for phase 1b
— Claude Haiku generates 2 alternative phrasings, we fuse N vector lists +
keyword. The interface is already in place; the caller just needs to supply
the variants.

## Voyage input_type, and why it matters

Voyage embeddings are asymmetric. Embedding the same text with
`input_type: "document"` vs `input_type: "query"` yields different vectors.
Mixing them collapses retrieval quality. `src/core/voyage.ts` requires the
type on every call; `import.ts` always passes `"document"`, `hybrid.ts`
always passes `"query"`.

## Tests

```bash
bun test          # 22 tests: chunking, RRF fusion, cosine, dedup, intent, markdown/slug safety
bun run typecheck
```

The suite covers the pure retrieval logic, so it runs with no database or API keys. One of the tests checks the slug guard: a note can't use frontmatter to overwrite another page.

## Repo layout

```
schema.sql                 pages, content_chunks (vector 2048), tsvector trigger
scripts/apply-schema.sh    psql wrapper for schema
src/cli.ts                 init-schema, import, embed, query, stats, serve
src/core/db.ts             postgres connection (auto-detects supabase tx pooler)
src/core/voyage.ts         embedding client with explicit input_type
src/core/markdown.ts       gray-matter parser, frontmatter preservation
src/core/chunker.ts        5-level recursive delimiter-aware chunker
src/core/engine.ts         pages + chunks + keyword/vector search
src/core/import.ts         walk + parse + hash + chunk + embed + upsert
src/core/search/hybrid.ts  RRF + cosine re-score with expandedQueries seam
src/core/search/dedup.ts   4-layer dedup with compiled_truth guarantee
src/core/search/intent.ts  zero-cost query intent classifier
src/mcp/server.ts          stdio MCP server (4 tools)
src/core/types.ts          shared types
```

## Deferred

- Query expansion with Claude Haiku (interface already reserved)
- Dream cycle / automated maintenance
- MarkItDown/Docling PDF extraction
- Whisper audio transcription
- Git-diff incremental sync (currently walks the whole dir on every import)
- Raw layer sync to S3

## Part of the OSA stack

| Repo | Role |
| --- | --- |
| [dumont-agent](https://github.com/PhelipeHonesto/dumont-agent) | Charter-brokerage agent |
| [osa-data-platform](https://github.com/PhelipeHonesto/osa-data-platform) | Aviation data ingestion and entity resolution |
| **ph-brain-engine** (this repo) | Memory substrate served over MCP |
| [Aviation-News-Aggregator](https://github.com/PhelipeHonesto/Aviation-News-Aggregator) | Loud Hawk: aviation news and signals |

## License

The original code is public for review; no license to use it is granted. Code ported from GBrain stays under its MIT License (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
