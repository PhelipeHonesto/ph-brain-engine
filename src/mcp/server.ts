/**
 * Stdio MCP server exposing 4 tools: search, get_page, list_pages, stats.
 *
 * Each tool returns enough metadata for an agent to follow up with minimal
 * extra round-trips. `search` in particular returns per-chunk results but
 * each one carries its parent slug + title + source_type + frontmatter
 * preview so the agent can decide whether to call `get_page` for full
 * context.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Engine } from '../core/engine.ts';
import { hybridSearch } from '../core/search/hybrid.ts';

const VERSION = '0.1.0';

export async function startMcpServer(engine: Engine): Promise<void> {
  const server = new Server(
    { name: 'ph-brain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search',
        description:
          'Hybrid semantic + keyword search over the PH-Brain vault. Returns ' +
          'ranked chunks with parent page metadata. Use this first; only call ' +
          'get_page when you need the full document body.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language search query.' },
            limit: { type: 'number', description: 'Max results (default 10, cap 100).' },
            source_type: {
              type: 'string',
              description: 'Filter to a single source type (claude-conversation, claude-project, etc.).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_page',
        description:
          'Fetch a single page by slug. Returns title, full compiled_truth body, timeline, ' +
          'source_type, frontmatter, and timestamps.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Page slug (from search results).' },
          },
          required: ['slug'],
        },
      },
      {
        name: 'list_pages',
        description: 'List pages, most recently updated first. Filter by source_type.',
        inputSchema: {
          type: 'object',
          properties: {
            source_type: { type: 'string' },
            limit: { type: 'number', description: 'Max results (default 50).' },
            offset: { type: 'number' },
          },
        },
      },
      {
        name: 'stats',
        description: 'Brain-wide counts (pages, chunks, embedded chunks) and pages by source_type.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const params = args ?? {};

    try {
      switch (name) {
        case 'search':   return ok(await handleSearch(engine, params));
        case 'get_page': return ok(await handleGetPage(engine, params));
        case 'list_pages': return ok(await handleListPages(engine, params));
        case 'stats':    return ok(await engine.getStats());
        default:         return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function handleSearch(engine: Engine, p: Record<string, unknown>) {
  const query = typeof p.query === 'string' ? p.query : '';
  if (!query.trim()) throw new Error('`query` is required');
  const limit = typeof p.limit === 'number' ? p.limit : 10;
  const source_type = typeof p.source_type === 'string' ? p.source_type : undefined;

  const results = await hybridSearch(engine, query, { limit, source_type });

  // Enrich each chunk with frontmatter preview so the agent can decide
  // whether it needs the full page body.
  const slugs = Array.from(new Set(results.map(r => r.slug)));
  const pages = await Promise.all(slugs.map(s => engine.getPage(s)));
  const bySlug = new Map(pages.filter(Boolean).map(p => [p!.slug, p!]));

  return {
    query,
    count: results.length,
    results: results.map(r => {
      const page = bySlug.get(r.slug);
      return {
        slug: r.slug,
        title: r.title,
        source_type: r.source_type,
        score: Number(r.score.toFixed(4)),
        chunk_source: r.chunk_source,
        chunk_index: r.chunk_index,
        chunk_text: r.chunk_text,
        page_updated_at: page?.updated_at ?? null,
        frontmatter: page?.frontmatter ?? {},
      };
    }),
  };
}

async function handleGetPage(engine: Engine, p: Record<string, unknown>) {
  const slug = typeof p.slug === 'string' ? p.slug : '';
  if (!slug) throw new Error('`slug` is required');
  const page = await engine.getPage(slug);
  if (!page) return { error: 'not_found', slug };
  return {
    slug: page.slug,
    title: page.title,
    source_type: page.source_type,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
}

async function handleListPages(engine: Engine, p: Record<string, unknown>) {
  const source_type = typeof p.source_type === 'string' ? p.source_type : undefined;
  const limit = typeof p.limit === 'number' ? p.limit : 50;
  const offset = typeof p.offset === 'number' ? p.offset : 0;
  const pages = await engine.listPages({ source_type, limit, offset });
  return {
    count: pages.length,
    pages: pages.map(p => ({
      slug: p.slug,
      title: p.title,
      source_type: p.source_type,
      updated_at: p.updated_at,
    })),
  };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
