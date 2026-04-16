/**
 * Hybrid search with Reciprocal Rank Fusion.
 * Ported from gbrain (src/core/search/hybrid.ts).
 *
 * Pipeline:
 *   1. Embed each query variant as "query" (NOT "document" — voyage produces
 *      different vectors depending on intent, and mixing collapses quality).
 *   2. Run N vector searches in parallel (one per variant) + 1 keyword search.
 *   3. RRF fusion: score = sum(1 / (K + rank)) across all lists.
 *   4. Normalize scores to 0-1 against the max.
 *   5. Cosine re-score: blended = 0.7*rrf + 0.3*cos(query, chunk) using the
 *      primary query embedding.
 *   6. 4-layer dedup.
 *
 * `expandedQueries` is accepted today but unused by the search layer — the
 * caller passes [query] for now. Phase 1b wires in Claude Haiku expansion.
 */

import type { Engine } from '../engine.ts';
import type { SearchResult, SearchOpts } from '../types.ts';
import { embed } from '../voyage.ts';
import { dedupResults } from './dedup.ts';
import type { DedupOptions } from './dedup.ts';

const RRF_K = 60;
const DEBUG = process.env.PH_BRAIN_SEARCH_DEBUG === '1';

export interface HybridSearchOptions extends SearchOpts {
  /**
   * Pre-expanded query variants. Defaults to [query]. Supplying 2-3 variants
   * from an upstream expander (Haiku, fixed templates, etc.) lets RRF fuse
   * multiple angles on the same question.
   */
  expandedQueries?: string[];
  rrfK?: number;
  dedupOpts?: DedupOptions;
}

export async function hybridSearch(
  engine: Engine,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const innerLimit = Math.min(limit * 3, 100);
  const rrfK = opts.rrfK ?? RRF_K;

  const searchOpts: SearchOpts = {
    limit: innerLimit,
    source_type: opts.source_type,
    exclude_slugs: opts.exclude_slugs,
  };

  // Keyword search is always available (no API key required).
  const keywordResults = await engine.searchKeyword(query, searchOpts);

  // Vector search requires Voyage. If the key is missing we fall back to
  // keyword-only; the failure mode is degraded recall, not an error.
  if (!process.env.VOYAGE_API_KEY) {
    return dedupResults(keywordResults, opts.dedupOpts).slice(offset, offset + limit);
  }

  const queries = (opts.expandedQueries && opts.expandedQueries.length > 0)
    ? opts.expandedQueries
    : [query];

  let vectorLists: SearchResult[][] = [];
  let primaryQueryEmbedding: Float32Array | null = null;
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q, 'query')));
    primaryQueryEmbedding = embeddings[0] ?? null;
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, searchOpts)),
    );
  } catch (e) {
    if (DEBUG) console.error(`[ph-brain-search] vector path failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (vectorLists.length === 0) {
    return dedupResults(keywordResults, opts.dedupOpts).slice(offset, offset + limit);
  }

  const allLists = [...vectorLists, keywordResults];
  let fused = rrfFusion(allLists, rrfK);

  if (primaryQueryEmbedding) {
    fused = await cosineReScore(engine, fused, primaryQueryEmbedding);
  }

  const deduped = dedupResults(fused, opts.dedupOpts);
  return deduped.slice(offset, offset + limit);
}

export function rrfFusion(lists: SearchResult[][], k: number): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      if (!r) continue;
      const key = `${r.slug}:${r.chunk_id}`;
      const rrfScore = 1 / (k + rank);
      const existing = scores.get(key);
      if (existing) existing.score += rrfScore;
      else scores.set(key, { result: r, score: rrfScore });
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) e.score = e.score / maxScore;
  }

  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

async function cosineReScore(
  engine: Engine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const chunkIds = results.map(r => r.chunk_id).filter((id): id is number => id != null);
  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds);
  } catch {
    return results;
  }
  if (embeddingMap.size === 0) return results;

  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    const chunkEmb = embeddingMap.get(r.chunk_id);
    if (!chunkEmb) return r;
    const cosine = cosineSimilarity(queryEmbedding, chunkEmb);
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;
    return { ...r, score: blended };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
