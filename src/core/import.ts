/**
 * Import orchestrator: walk a directory, parse markdown, chunk, embed, upsert.
 *
 * Flow per file:
 *   1. readFile + parseMarkdown
 *   2. compute content_hash — skip if unchanged
 *   3. chunk compiled_truth
 *   4. embedBatch(chunks, "document") — BEFORE the transaction, since it's
 *      an external API call and we do not want to hold DB locks across it
 *   5. transaction: putPage + upsertChunks
 *
 * Safety:
 *   - Refuses to follow symlinks (a symlink in the vault could point anywhere
 *     the importing user can read).
 *   - Rejects files whose frontmatter slug disagrees with the file's path.
 *   - Caps file size at 5MB.
 */

import { readFileSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

import type { Engine } from './engine.ts';
import { parseMarkdown } from './markdown.ts';
import { chunkText } from './chunker.ts';
import { embedBatch } from './voyage.ts';
import type { ChunkInput } from './types.ts';

const MAX_FILE_SIZE = 5_000_000;

export interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'unchanged' | 'error';
  chunks: number;
  error?: string;
}

export interface ImportSummary {
  imported: number;
  unchanged: number;
  skipped: number;
  errors: number;
  chunksCreated: number;
  durationMs: number;
  importedSlugs: string[];
}

export interface ImportOptions {
  /** Skip the voyage call. Chunks are written without embeddings. */
  noEmbed?: boolean;
  /** Called once per file after it finishes. Use for progress logging. */
  onProgress?: (processed: number, total: number, result: ImportResult) => void;
}

export async function importDirectory(
  engine: Engine,
  dir: string,
  opts: ImportOptions = {},
): Promise<ImportSummary> {
  const files = collectMarkdownFiles(dir);
  const start = Date.now();
  const importedSlugs: string[] = [];
  let imported = 0, unchanged = 0, skipped = 0, errors = 0, chunksCreated = 0;

  for (let i = 0; i < files.length; i++) {
    const fullPath = files[i];
    if (!fullPath) continue;
    const relativePath = relative(dir, fullPath);
    let result: ImportResult;
    try {
      result = await importFile(engine, fullPath, relativePath, opts);
    } catch (e) {
      result = {
        slug: relativePath,
        status: 'error',
        chunks: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    switch (result.status) {
      case 'imported':  imported++;  chunksCreated += result.chunks; importedSlugs.push(result.slug); break;
      case 'unchanged': unchanged++; break;
      case 'skipped':   skipped++;   break;
      case 'error':     errors++;    break;
    }

    opts.onProgress?.(i + 1, files.length, result);
  }

  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `imported=${imported} unchanged=${unchanged} skipped=${skipped} errors=${errors} chunks=${chunksCreated}`,
  });

  return {
    imported, unchanged, skipped, errors, chunksCreated,
    durationMs: Date.now() - start,
    importedSlugs,
  };
}

export async function importFile(
  engine: Engine,
  fullPath: string,
  relativePath: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const lstat = lstatSync(fullPath);
  if (lstat.isSymbolicLink()) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: 'symlink refused' };
  }
  const stat = statSync(fullPath);
  if (stat.size > MAX_FILE_SIZE) {
    return { slug: relativePath, status: 'skipped', chunks: 0, error: `too large (${stat.size}B)` };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const parsed = parseMarkdown(content, { relativePath });

  const hash = createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      source_type: parsed.sourceType,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    }))
    .digest('hex');

  const existing = await engine.getPage(parsed.slug);
  if (existing?.content_hash === hash) {
    return { slug: parsed.slug, status: 'unchanged', chunks: 0 };
  }

  const chunks: ChunkInput[] = [];
  if (parsed.compiled_truth.trim()) {
    for (const c of chunkText(parsed.compiled_truth)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: c.text,
        chunk_source: 'compiled_truth',
      });
    }
  }
  if (parsed.timeline.trim()) {
    for (const c of chunkText(parsed.timeline)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: c.text,
        chunk_source: 'timeline',
      });
    }
  }

  // Embed BEFORE the transaction — external API call.
  if (!opts.noEmbed && chunks.length > 0) {
    try {
      const embeddings = await embedBatch(chunks.map(c => c.chunk_text), 'document');
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const emb = embeddings[i];
        if (chunk && emb) {
          chunk.embedding = emb;
          chunk.token_count = Math.ceil(chunk.chunk_text.length / 4);
        }
      }
    } catch (e) {
      // Non-fatal: we still write the page and chunks without embeddings.
      // The `embed --stale` flow will fill them in later.
      console.warn(`[ph-brain] embedding failed for ${parsed.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await engine.transaction(async tx => {
    await tx.putPage(parsed.slug, {
      source_type: parsed.sourceType,
      title: parsed.title,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      content_hash: hash,
    });
    if (chunks.length > 0) {
      await tx.upsertChunks(parsed.slug, chunks);
    } else {
      await tx.deleteChunks(parsed.slug);
    }
  });

  return { slug: parsed.slug, status: 'imported', chunks: chunks.length };
}

/**
 * Embed (or re-embed) chunks that are missing embeddings.
 * If `staleOnly` is false, re-embeds every chunk of every page.
 */
export async function embedAll(
  engine: Engine,
  opts: { staleOnly?: boolean } = {},
): Promise<{ pages: number; chunks: number }> {
  const staleOnly = opts.staleOnly ?? true;
  const pages = await engine.listPages({ limit: 100_000 });
  let chunksEmbedded = 0;

  for (const page of pages) {
    const chunks = await engine.getChunks(page.slug);
    const toEmbed = staleOnly ? chunks.filter(c => !c.embedded_at) : chunks;
    if (toEmbed.length === 0) continue;

    try {
      const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text), 'document');
      const byIndex = new Map<number, Float32Array>();
      for (let i = 0; i < toEmbed.length; i++) {
        const ch = toEmbed[i];
        const emb = embeddings[i];
        if (ch && emb) byIndex.set(ch.chunk_index, emb);
      }

      const updated: ChunkInput[] = chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: byIndex.get(c.chunk_index) ?? undefined,
        token_count: c.token_count ?? Math.ceil(c.chunk_text.length / 4),
      }));

      await engine.upsertChunks(page.slug, updated);
      chunksEmbedded += toEmbed.length;
    } catch (e) {
      console.warn(`[ph-brain] embed failed for ${page.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { pages: pages.length, chunks: chunksEmbedded };
}

export function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      console.warn(`[ph-brain] cannot read ${d}`);
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;

      const full = join(d, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        console.warn(`[ph-brain] skipping unreadable path: ${full}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        console.warn(`[ph-brain] skipping symlink: ${full}`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
