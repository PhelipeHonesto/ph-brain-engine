import { describe, expect, test } from 'bun:test';
import { chunkText } from '../src/core/chunker.ts';
import { rrfFusion, cosineSimilarity } from '../src/core/search/hybrid.ts';
import { dedupResults } from '../src/core/search/dedup.ts';
import { classifyQueryIntent } from '../src/core/search/intent.ts';
import { parseMarkdown, slugifyPath } from '../src/core/markdown.ts';
import type { SearchResult } from '../src/core/types.ts';

function result(overrides: Partial<SearchResult>): SearchResult {
  return {
    slug: 'notes/a',
    page_id: 1,
    title: 'A',
    source_type: 'concept',
    chunk_id: 1,
    chunk_index: 0,
    chunk_text: 'alpha',
    chunk_source: 'compiled_truth',
    score: 1,
    ...overrides,
  };
}

const words = (n: number, prefix = 'w') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

describe('chunkText', () => {
  test('returns nothing for empty or whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  test('keeps short text as a single chunk', () => {
    expect(chunkText('  one short note  ')).toEqual([{ text: 'one short note', index: 0 }]);
  });

  test('splits long text into indexed chunks near the target size', () => {
    const text = Array.from({ length: 12 }, (_, i) => `${words(80, `p${i}w`)}.`).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    for (const c of chunks) {
      expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(150);
    }
  });

  test('never loses words when overlap is off', () => {
    const text = Array.from({ length: 10 }, (_, i) => `${words(60, `s${i}w`)}.`).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 0 });
    const rebuilt = chunks.map((c) => c.text).join(' ').split(/\s+/);
    expect(rebuilt).toEqual(text.split(/\s+/));
  });

  test('carries trailing context into the next chunk when overlap is on', () => {
    const text = Array.from({ length: 6 }, (_, i) => `${words(120, `o${i}w`)}.`).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 150, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const firstTail = chunks[0]!.text.split(/\s+/).slice(-5).join(' ');
    expect(chunks[1]!.text).toContain(firstTail);
  });
});

describe('rrfFusion', () => {
  test('ranks a result found by both retrievers above single-list hits', () => {
    const shared = result({ slug: 'shared', chunk_id: 10 });
    const vector = [result({ slug: 'v-only', chunk_id: 1 }), shared];
    const keyword = [result({ slug: 'k-only', chunk_id: 2 }), shared];

    const fused = rrfFusion([vector, keyword], 60);

    expect(fused[0]!.slug).toBe('shared');
    expect(fused[0]!.score).toBe(1);
    expect(fused).toHaveLength(3);
  });

  test('normalizes scores into 0..1', () => {
    const fused = rrfFusion([[result({ chunk_id: 1 }), result({ chunk_id: 2 })]], 60);
    for (const r of fused) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  test('handles empty input', () => {
    expect(rrfFusion([[], []], 60)).toEqual([]);
  });
});

describe('cosineSimilarity', () => {
  test('is 1 for identical direction, 0 for orthogonal, -1 for opposite', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, new Float32Array([2, 4, 6]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosineSimilarity(a, new Float32Array([-1, -2, -3]))).toBeCloseTo(-1, 6);
  });

  test('returns 0 instead of NaN for a zero vector', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe('dedupResults', () => {
  test('caps chunks per page', () => {
    const input = [1, 2, 3, 4].map((i) =>
      result({ chunk_id: i, score: 1 - i / 10, chunk_text: `unique text number ${i} ${words(5, `u${i}`)}` }),
    );
    const out = dedupResults(input, { maxPerPage: 2, maxTypeRatio: 1 });
    expect(out.filter((r) => r.slug === 'notes/a')).toHaveLength(2);
  });

  test('drops near-duplicate chunk text', () => {
    const text = words(30, 'dup');
    const input = [
      result({ slug: 'a', chunk_id: 1, chunk_text: text, score: 0.9 }),
      result({ slug: 'b', chunk_id: 2, chunk_text: text, score: 0.8 }),
    ];
    expect(dedupResults(input, { maxTypeRatio: 1 })).toHaveLength(1);
  });

  test('keeps any one source type from dominating the results', () => {
    const input = [
      ...[1, 2, 3, 4].map((i) =>
        result({ slug: `c${i}`, chunk_id: i, source_type: 'concept', score: 1 - i / 100, chunk_text: words(8, `c${i}x`) }),
      ),
      result({ slug: 'p1', chunk_id: 9, source_type: 'person', score: 0.5, chunk_text: words(8, 'px') }),
    ];
    const out = dedupResults(input);
    const concepts = out.filter((r) => r.source_type === 'concept').length;
    expect(concepts).toBeLessThanOrEqual(Math.ceil(input.length * 0.6));
    expect(out.some((r) => r.source_type === 'person')).toBe(true);
  });

  test('guarantees a compiled_truth chunk for every kept page', () => {
    const input = [
      result({ chunk_id: 1, chunk_source: 'timeline', score: 0.9, chunk_text: words(6, 't1') }),
      result({ chunk_id: 2, chunk_source: 'timeline', score: 0.8, chunk_text: words(6, 't2') }),
      result({ chunk_id: 3, chunk_source: 'compiled_truth', score: 0.1, chunk_text: words(6, 'ct') }),
    ];
    const out = dedupResults(input, { maxPerPage: 2, maxTypeRatio: 1 });
    expect(out.some((r) => r.chunk_source === 'compiled_truth')).toBe(true);
  });
});

describe('classifyQueryIntent', () => {
  test.each([
    ['when did we last talk to the operator', 'temporal'],
    ['give me everything on Wheels Up', 'temporal'],
    ['did they announce an acquisition', 'event'],
    ['who is the chief pilot', 'entity'],
    ['charter brokerage operating model', 'general'],
  ] as const)('%s -> %s', (query, intent) => {
    expect(classifyQueryIntent(query)).toBe(intent);
  });
});

describe('markdown parsing', () => {
  test('derives the slug from the path', () => {
    expect(slugifyPath('/sources//claude-conversations/2026-03-08-foo.md')).toBe(
      'sources/claude-conversations/2026-03-08-foo',
    );
    expect(slugifyPath('notes\\people\\jane.MDX')).toBe('notes/people/jane');
  });

  test('moves title and source onto columns and keeps the rest of frontmatter', () => {
    const md = '---\ntitle: Ops Review\nsource: memo\ntags: [ops]\n---\n\nBody here.\n';
    const parsed = parseMarkdown(md, { relativePath: 'notes/ops-review.md' });

    expect(parsed.slug).toBe('notes/ops-review');
    expect(parsed.title).toBe('Ops Review');
    expect(parsed.sourceType).toBe('memo');
    expect(parsed.compiled_truth).toBe('Body here.');
    expect(parsed.frontmatter).toEqual({ tags: ['ops'] });
  });

  test('rejects a frontmatter slug that tries to overwrite another page', () => {
    const md = '---\nslug: people/someone-else\n---\nhi';
    expect(() => parseMarkdown(md, { relativePath: 'notes/mine.md' })).toThrow(/does not match/);
  });
});
