#!/usr/bin/env bun
/**
 * PH-Brain Engine CLI.
 *
 * Commands:
 *   init-schema                  Apply schema.sql to $DATABASE_URL
 *   import <dir> [--no-embed]    Ingest a markdown directory
 *   embed [--all | --stale]      Fill in missing embeddings
 *   query <text> [--limit N]     Run hybrid search
 *   serve                        Run MCP server over stdio
 *   stats                        Print brain stats
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { connect, disconnect } from './core/db.ts';
import { Engine } from './core/engine.ts';
import { importDirectory, embedAll } from './core/import.ts';
import { hybridSearch } from './core/search/hybrid.ts';
import { startMcpServer } from './mcp/server.ts';
import { MODEL, DIMENSIONS } from './core/voyage.ts';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') return printHelp();
  if (cmd === 'version' || cmd === '--version') {
    console.log(`ph-brain 0.1.0 (${MODEL} @ ${DIMENSIONS}d)`);
    return;
  }

  switch (cmd) {
    case 'init-schema': return runInitSchema();
    case 'import':      return withEngine(engine => runImport(engine, rest));
    case 'embed':       return withEngine(engine => runEmbed(engine, rest));
    case 'query':       return withEngine(engine => runQuery(engine, rest));
    case 'stats':       return withEngine(engine => runStats(engine));
    case 'serve':       return withEngine(engine => startMcpServer(engine), { keepOpen: true });
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

async function withEngine(
  fn: (engine: Engine) => Promise<void>,
  opts: { keepOpen?: boolean } = {},
): Promise<void> {
  connect();
  const engine = new Engine();
  try {
    await fn(engine);
  } finally {
    if (!opts.keepOpen) await disconnect();
  }
}

async function runInitSchema(): Promise<void> {
  const schemaPath = resolve(import.meta.dir, '..', 'schema.sql');
  if (!existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }
  const schema = readFileSync(schemaPath, 'utf-8');
  const sql = connect();
  try {
    await sql.unsafe(schema);
    console.log(`Applied ${schemaPath}`);
  } finally {
    await disconnect();
  }
}

async function runImport(engine: Engine, args: string[]): Promise<void> {
  const noEmbed = args.includes('--no-embed');
  const dir = args.find(a => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: ph-brain import <dir> [--no-embed]');
    process.exit(1);
  }
  const absDir = resolve(dir);
  console.log(`Importing ${absDir}${noEmbed ? ' (no embed)' : ''}...`);

  const start = Date.now();
  const summary = await importDirectory(engine, absDir, {
    noEmbed,
    onProgress: (processed, total, result) => {
      if (result.status === 'error') {
        console.error(`  [${processed}/${total}] ERROR ${result.slug}: ${result.error}`);
      } else if (processed % 10 === 0 || processed === total) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = elapsed > 0 ? (processed / elapsed).toFixed(1) : '?';
        process.stderr.write(`  ${processed}/${total} (${rate}/s)\r`);
      }
    },
  });

  console.log('');
  console.log(`Import complete in ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log(`  imported:  ${summary.imported}`);
  console.log(`  unchanged: ${summary.unchanged}`);
  console.log(`  skipped:   ${summary.skipped}`);
  console.log(`  errors:    ${summary.errors}`);
  console.log(`  chunks:    ${summary.chunksCreated}`);
}

async function runEmbed(engine: Engine, args: string[]): Promise<void> {
  const staleOnly = !args.includes('--all');
  console.log(`Embedding ${staleOnly ? 'stale chunks only' : 'all chunks'}...`);
  const result = await embedAll(engine, { staleOnly });
  console.log(`Embedded ${result.chunks} chunks across ${result.pages} pages`);
}

async function runQuery(engine: Engine, args: string[]): Promise<void> {
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1] ?? '10') : 10;
  const typeIdx = args.indexOf('--type');
  const source_type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;

  const query = args
    .filter((a, i) => {
      if (a.startsWith('--')) return false;
      if (args[i - 1] === '--limit' || args[i - 1] === '--type') return false;
      return true;
    })
    .join(' ');

  if (!query.trim()) {
    console.error('Usage: ph-brain query <text> [--limit N] [--type SOURCE]');
    process.exit(1);
  }

  const results = await hybridSearch(engine, query, { limit, source_type });
  if (results.length === 0) {
    console.log('No results.');
    return;
  }
  for (const r of results) {
    const score = r.score.toFixed(4);
    const preview = r.chunk_text.replace(/\s+/g, ' ').slice(0, 140);
    console.log(`[${score}] ${r.slug}  (${r.source_type})`);
    console.log(`        ${r.title}`);
    console.log(`        ${preview}${r.chunk_text.length > 140 ? '...' : ''}`);
    console.log('');
  }
}

async function runStats(engine: Engine): Promise<void> {
  const stats = await engine.getStats();
  console.log(`Pages:    ${stats.page_count}`);
  console.log(`Chunks:   ${stats.chunk_count}`);
  console.log(`Embedded: ${stats.embedded_count}`);
  if (Object.keys(stats.pages_by_source_type).length > 0) {
    console.log('');
    console.log('By source_type:');
    for (const [k, v] of Object.entries(stats.pages_by_source_type)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

function printHelp(): void {
  console.log(`ph-brain 0.1.0 — personal intelligence substrate

USAGE
  ph-brain <command> [options]

COMMANDS
  init-schema              Apply schema.sql to $DATABASE_URL
  import <dir>             Ingest a markdown directory
    --no-embed               Skip voyage embedding (import text only)
  embed                    Fill in missing embeddings
    --all                    Re-embed every chunk (expensive)
  query <text>             Hybrid search the brain
    --limit N                Max results (default 10)
    --type SOURCE            Filter to one source_type
  stats                    Counts and breakdown by source_type
  serve                    Run MCP server over stdio (for Claude Code)
  version                  Print version and model info

ENVIRONMENT
  DATABASE_URL             Supabase Postgres URL (required)
  VOYAGE_API_KEY           Voyage AI API key (required for embed/query vectors)
  VOYAGE_MODEL             Override model (default voyage-3-large)
  VOYAGE_DIMENSIONS        Override dims (default 2048)
`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
