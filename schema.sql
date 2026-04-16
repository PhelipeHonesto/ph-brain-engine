-- PH-Brain Engine — Postgres + pgvector schema
--
-- Target: Supabase Postgres with pgvector 0.7+.
-- Embedding model: Voyage AI voyage-3-large @ 2048 dimensions.
--
-- We use `halfvec(2048)` (half-precision float16) instead of `vector(2048)`
-- because pgvector's HNSW index caps the regular `vector` type at 2000
-- dimensions. `halfvec` with HNSW supports up to 4000 dims with negligible
-- recall loss. Query-time casts inline the ::halfvec type.
--
-- Phase 1 keeps compiled_truth + timeline columns even though import writes
-- only to compiled_truth — this leaves the phase 2 dream-cycle path wired.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- pages: one row per source markdown file
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id             SERIAL PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,
  source_type    TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  compiled_truth TEXT    NOT NULL DEFAULT '',
  timeline       TEXT    NOT NULL DEFAULT '',
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  content_hash   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_source_type ON pages(source_type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_title_trgm  ON pages USING GIN(title gin_trgm_ops);

-- ============================================================
-- content_chunks: 300-word chunks with 2048-dim Voyage embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            SERIAL PRIMARY KEY,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding     halfvec(2048),
  model         TEXT    NOT NULL DEFAULT 'voyage-3-large',
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page      ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding halfvec_cosine_ops);

-- ============================================================
-- ingest_log: audit trail for each import run
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated JSONB   NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- config: brain-level settings (embedding model/dims, checkpoint state, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('schema_version',       '1'),
  ('embedding_model',      'voyage-3-large'),
  ('embedding_dimensions', '2048'),
  ('chunk_strategy',       'recursive'),
  ('chunk_size_words',     '300'),
  ('chunk_overlap_words',  '50')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Weighted tsvector over title/compiled_truth/timeline
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();

-- ============================================================
-- Row Level Security: block anon reads via REST. Only enable when the
-- connecting role actually has BYPASSRLS (the Supabase `postgres` role),
-- otherwise we would lock ourselves out.
-- ============================================================
DO $$
DECLARE
  has_bypass BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
  IF has_bypass THEN
    ALTER TABLE pages          ENABLE ROW LEVEL SECURITY;
    ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ingest_log     ENABLE ROW LEVEL SECURITY;
    ALTER TABLE config         ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'RLS enabled on all tables (role % has BYPASSRLS)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS. Run as postgres to enable.', current_user;
  END IF;
END $$;
