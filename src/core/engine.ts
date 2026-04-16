/**
 * PostgresEngine — thin, hand-rolled data access for PH-Brain.
 *
 * Only the operations phase 1 needs: page CRUD, chunk upsert, keyword and
 * vector search, stats. No operation registry, no PGLite fallback, no links/
 * tags/timeline tables. Easy to extend when phase 2 adds them.
 */

import type { Sql } from './db.ts';
import { getConnection } from './db.ts';
import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  BrainStats,
  IngestLogInput,
} from './types.ts';
import { MODEL as DEFAULT_MODEL } from './voyage.ts';

export const MAX_SEARCH_LIMIT = 100;

export function clampSearchLimit(limit: number | undefined, defaultLimit = 20): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), MAX_SEARCH_LIMIT);
}

export class Engine {
  constructor(private _sql?: Sql) {}

  private get sql(): Sql {
    return this._sql ?? getConnection();
  }

  async transaction<T>(fn: (engine: Engine) => Promise<T>): Promise<T> {
    const result = await this.sql.begin(async tx => {
      const txEngine = new Engine(tx as unknown as Sql);
      return fn(txEngine);
    });
    return result as T;
  }

  // ----------------------------------------------------------------
  // Pages
  // ----------------------------------------------------------------
  async getPage(slug: string): Promise<Page | null> {
    const rows = await this.sql<Page[]>`
      SELECT id, slug, source_type, title, compiled_truth, timeline,
             frontmatter, content_hash, created_at, updated_at
      FROM pages WHERE slug = ${slug}
    `;
    return rows[0] ?? null;
  }

  async putPage(slug: string, input: PageInput): Promise<Page> {
    const frontmatter = input.frontmatter ?? {};
    const rows = await this.sql<Page[]>`
      INSERT INTO pages (slug, source_type, title, compiled_truth, timeline,
                         frontmatter, content_hash, updated_at)
      VALUES (${slug}, ${input.source_type}, ${input.title},
              ${input.compiled_truth}, ${input.timeline ?? ''},
              ${this.sql.json(frontmatter as Record<string, any>)},
              ${input.content_hash}, now())
      ON CONFLICT (slug) DO UPDATE SET
        source_type    = EXCLUDED.source_type,
        title          = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        timeline       = EXCLUDED.timeline,
        frontmatter    = EXCLUDED.frontmatter,
        content_hash   = EXCLUDED.content_hash,
        updated_at     = now()
      RETURNING id, slug, source_type, title, compiled_truth, timeline,
                frontmatter, content_hash, created_at, updated_at
    `;
    const page = rows[0];
    if (!page) throw new Error(`putPage returned no row for slug ${slug}`);
    return page;
  }

  async deletePage(slug: string): Promise<void> {
    await this.sql`DELETE FROM pages WHERE slug = ${slug}`;
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    if (filters?.source_type) {
      return this.sql<Page[]>`
        SELECT id, slug, source_type, title, compiled_truth, timeline,
               frontmatter, content_hash, created_at, updated_at
        FROM pages WHERE source_type = ${filters.source_type}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }
    return this.sql<Page[]>`
      SELECT id, slug, source_type, title, compiled_truth, timeline,
             frontmatter, content_hash, created_at, updated_at
      FROM pages
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }

  // ----------------------------------------------------------------
  // Chunks
  // ----------------------------------------------------------------
  async getChunks(slug: string): Promise<Chunk[]> {
    return this.sql<Chunk[]>`
      SELECT cc.id, cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
             cc.embedding, cc.model, cc.token_count, cc.embedded_at
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ${slug}
      ORDER BY cc.chunk_index
    `;
  }

  async deleteChunks(slug: string): Promise<void> {
    await this.sql`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
    `;
  }

  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const sql = this.sql;

    const pageRows = await sql<{ id: number }[]>`
      SELECT id FROM pages WHERE slug = ${slug}
    `;
    const page = pageRows[0];
    if (!page) throw new Error(`upsertChunks failed: page ${slug} not found`);
    const pageId = page.id;

    if (chunks.length === 0) {
      await sql`DELETE FROM content_chunks WHERE page_id = ${pageId}`;
      return;
    }

    const indices = chunks.map(c => c.chunk_index);
    await sql`
      DELETE FROM content_chunks
      WHERE page_id = ${pageId} AND chunk_index != ALL(${indices}::int[])
    `;

    // Hand-built multi-row INSERT ... ON CONFLICT. The `postgres` driver's
    // parameterized API does not cleanly handle vector casts inline, so we
    // build the VALUES list textually and pass primitives as parameters.
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)';
    const rows: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    for (const chunk of chunks) {
      const embStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;
      const model = chunk.model ?? DEFAULT_MODEL;
      const tokens = chunk.token_count ?? null;

      if (embStr) {
        rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::vector, $${p++}, $${p++}, now())`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, embStr, model, tokens);
      } else {
        rows.push(`($${p++}, $${p++}, $${p++}, $${p++}, NULL, $${p++}, $${p++}, NULL)`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, model, tokens);
      }
    }

    await sql.unsafe(
      `INSERT INTO content_chunks ${cols} VALUES ${rows.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text   = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding    = CASE
                          WHEN EXCLUDED.chunk_text != content_chunks.chunk_text
                            THEN EXCLUDED.embedding
                          ELSE COALESCE(EXCLUDED.embedding, content_chunks.embedding)
                        END,
         model        = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count  = EXCLUDED.token_count,
         embedded_at  = COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at)`,
      params as never[],
    );
  }

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset ?? 0;

    await sql`SET statement_timeout = '8s'`;
    try {
      const rows = await sql<SearchResult[]>`
        WITH ranked_pages AS (
          SELECT p.id, p.slug, p.title, p.source_type,
            ts_rank(p.search_vector, websearch_to_tsquery('english', ${query})) AS score
          FROM pages p
          WHERE p.search_vector @@ websearch_to_tsquery('english', ${query})
            ${opts?.source_type ? sql`AND p.source_type = ${opts.source_type}` : sql``}
            ${opts?.exclude_slugs?.length ? sql`AND p.slug != ALL(${opts.exclude_slugs})` : sql``}
          ORDER BY score DESC
          LIMIT ${limit} OFFSET ${offset}
        ),
        best_chunks AS (
          SELECT DISTINCT ON (rp.slug)
            rp.slug, rp.id AS page_id, rp.title, rp.source_type, rp.score,
            cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
          FROM ranked_pages rp
          JOIN content_chunks cc ON cc.page_id = rp.id
          ORDER BY rp.slug, cc.chunk_index
        )
        SELECT slug, page_id, title, source_type, chunk_id, chunk_index,
               chunk_text, chunk_source, score
        FROM best_chunks
        ORDER BY score DESC
      `;
      return rows;
    } finally {
      await sql`SET statement_timeout = '0'`;
    }
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset ?? 0;
    const vec = '[' + Array.from(embedding).join(',') + ']';

    await sql`SET statement_timeout = '8s'`;
    try {
      const rows = await sql<SearchResult[]>`
        SELECT
          p.slug, p.id AS page_id, p.title, p.source_type,
          cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          1 - (cc.embedding <=> ${vec}::vector) AS score
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL
          ${opts?.source_type ? sql`AND p.source_type = ${opts.source_type}` : sql``}
          ${opts?.exclude_slugs?.length ? sql`AND p.slug != ALL(${opts.exclude_slugs})` : sql``}
        ORDER BY cc.embedding <=> ${vec}::vector
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows;
    } finally {
      await sql`SET statement_timeout = '0'`;
    }
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const rows = await this.sql<{ id: number; embedding: number[] | null }[]>`
      SELECT id, embedding FROM content_chunks
      WHERE id = ANY(${ids}::int[]) AND embedding IS NOT NULL
    `;
    const out = new Map<number, Float32Array>();
    for (const row of rows) {
      if (row.embedding) {
        // pgvector rows come back as number[] via the `postgres` driver
        const vec = Array.isArray(row.embedding)
          ? row.embedding
          : parseVectorString(row.embedding as unknown as string);
        out.set(row.id, new Float32Array(vec));
      }
    }
    return out;
  }

  // ----------------------------------------------------------------
  // Stats + ingest log
  // ----------------------------------------------------------------
  async getStats(): Promise<BrainStats> {
    const sql = this.sql;
    const [stats] = await sql<{ page_count: number; chunk_count: number; embedded_count: number }[]>`
      SELECT
        (SELECT count(*) FROM pages)::int           AS page_count,
        (SELECT count(*) FROM content_chunks)::int  AS chunk_count,
        (SELECT count(*) FROM content_chunks
          WHERE embedded_at IS NOT NULL)::int       AS embedded_count
    `;
    const types = await sql<{ source_type: string; count: number }[]>`
      SELECT source_type, count(*)::int AS count FROM pages
      GROUP BY source_type ORDER BY count DESC
    `;
    const pages_by_source_type: Record<string, number> = {};
    for (const t of types) pages_by_source_type[t.source_type] = t.count;

    return {
      page_count: stats?.page_count ?? 0,
      chunk_count: stats?.chunk_count ?? 0,
      embedded_count: stats?.embedded_count ?? 0,
      pages_by_source_type,
    };
  }

  async logIngest(entry: IngestLogInput): Promise<void> {
    await this.sql`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (${entry.source_type}, ${entry.source_ref},
              ${this.sql.json(entry.pages_updated)}, ${entry.summary})
    `;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async getConfig(key: string): Promise<string | null> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT value FROM config WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  }
}

function parseVectorString(s: string): number[] {
  // pgvector text format: "[0.1,0.2,...]"
  return s.replace(/^\[|\]$/g, '').split(',').map(Number);
}
