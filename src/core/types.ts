export interface Page {
  id: number;
  slug: string;
  source_type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PageInput {
  source_type: string;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash: string;
}

export interface PageFilters {
  source_type?: string;
  limit?: number;
  offset?: number;
}

export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
}

export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  source_type: string;
  chunk_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  score: number;
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
  source_type?: string;
  exclude_slugs?: string[];
}

export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  pages_by_source_type: Record<string, number>;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}
