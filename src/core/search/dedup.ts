/**
 * 4-layer dedup pipeline.
 * Ported from gbrain (src/core/search/dedup.ts).
 *
 * 1. Top 3 chunks per page by score
 * 2. Remove chunks with Jaccard similarity > 0.85 vs already-kept results
 * 3. Type diversity: no source_type exceeds 60% of output
 * 4. Cap chunks per page at 2
 *
 * Final: compiled_truth guarantee — for each kept page, ensure at least one
 * compiled_truth chunk is present (swap the lowest-scored chunk of that page
 * for the best compiled_truth chunk from the pre-dedup input).
 */

import type { SearchResult } from '../types.ts';

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;

export interface DedupOptions {
  cosineThreshold?: number;
  maxTypeRatio?: number;
  maxPerPage?: number;
}

export function dedupResults(
  results: SearchResult[],
  opts: DedupOptions = {},
): SearchResult[] {
  const threshold = opts.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts.maxPerPage ?? MAX_PER_PAGE;

  const preDedup = results;
  let deduped = results;

  deduped = dedupBySource(deduped);
  deduped = dedupByTextSimilarity(deduped, threshold);
  deduped = enforceTypeDiversity(deduped, maxRatio);
  deduped = capPerPage(deduped, maxPerPage);
  deduped = guaranteeCompiledTruth(deduped, preDedup);

  return deduped;
}

function dedupBySource(results: SearchResult[]): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const arr = byPage.get(r.slug) ?? [];
    arr.push(r);
    byPage.set(r.slug, arr);
  }
  const kept: SearchResult[] = [];
  for (const chunks of byPage.values()) {
    chunks.sort((a, b) => b.score - a.score);
    kept.push(...chunks.slice(0, 3));
  }
  return kept.sort((a, b) => b.score - a.score);
}

function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const kept: SearchResult[] = [];
  for (const r of results) {
    const rWords = new Set(r.chunk_text.toLowerCase().split(/\s+/));
    let tooSimilar = false;
    for (const k of kept) {
      const kWords = new Set(k.chunk_text.toLowerCase().split(/\s+/));
      const intersection = new Set([...rWords].filter(w => kWords.has(w)));
      const union = new Set([...rWords, ...kWords]);
      const jaccard = union.size === 0 ? 0 : intersection.size / union.size;
      if (jaccard > threshold) { tooSimilar = true; break; }
    }
    if (!tooSimilar) kept.push(r);
  }
  return kept;
}

function enforceTypeDiversity(results: SearchResult[], maxRatio: number): SearchResult[] {
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  for (const r of results) {
    const count = counts.get(r.source_type) ?? 0;
    if (count < maxPerType) {
      kept.push(r);
      counts.set(r.source_type, count + 1);
    }
  }
  return kept;
}

function capPerPage(results: SearchResult[], maxPerPage: number): SearchResult[] {
  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  for (const r of results) {
    const count = counts.get(r.slug) ?? 0;
    if (count < maxPerPage) {
      kept.push(r);
      counts.set(r.slug, count + 1);
    }
  }
  return kept;
}

function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const arr = byPage.get(r.slug) ?? [];
    arr.push(r);
    byPage.set(r.slug, arr);
  }

  const output = [...results];

  for (const [slug, pageChunks] of byPage) {
    if (pageChunks.some(c => c.chunk_source === 'compiled_truth')) continue;
    const candidate = preDedup
      .filter(r => r.slug === slug && r.chunk_source === 'compiled_truth')
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) continue;

    let lowestIdx = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < output.length; i++) {
      const r = output[i];
      if (!r || r.slug !== slug) continue;
      if (r.score < lowestScore) {
        lowestScore = r.score;
        lowestIdx = i;
      }
    }
    if (lowestIdx !== -1) output[lowestIdx] = candidate;
  }

  return output;
}
