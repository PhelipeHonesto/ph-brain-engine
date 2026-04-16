/**
 * Markdown parser with frontmatter preservation.
 *
 * Phase 1 collapses body content into `compiled_truth`. The schema still has
 * a `timeline` column so the phase 2 dream-cycle compile step can split
 * generated summaries from source-of-truth content later.
 *
 * All frontmatter fields are preserved on the page row as JSONB so phase 2
 * can filter search results by source_type, created date, uuid, etc.
 */

import matter from 'gray-matter';

export interface ParsedMarkdown {
  /** Path-derived slug (the authoritative id) */
  slug: string;
  /** Source category inferred from folder (claude-conversation, claude-project, ...) */
  sourceType: string;
  title: string;
  /** Full body content, minus frontmatter */
  compiled_truth: string;
  /** Empty in phase 1; reserved for phase 2 dream-cycle output */
  timeline: string;
  /** Every frontmatter field, verbatim (minus ones we move onto columns) */
  frontmatter: Record<string, unknown>;
}

export interface ParseOptions {
  /** Path to the file, relative to the import root. Required. */
  relativePath: string;
}

/**
 * Parse a markdown file with YAML frontmatter.
 *
 * `slug` is derived from the relative path. If the frontmatter declares a
 * different `slug`, we reject the file rather than honor it — otherwise any
 * source file could silently overwrite an unrelated page by claiming its
 * slug. (Same security control as gbrain.)
 */
export function parseMarkdown(content: string, opts: ParseOptions): ParsedMarkdown {
  const { data, content: body } = matter(content);

  const frontmatter = { ...data };

  const expectedSlug = slugifyPath(opts.relativePath);
  const declaredSlug = typeof frontmatter.slug === 'string' ? frontmatter.slug : undefined;
  if (declaredSlug && declaredSlug !== expectedSlug) {
    throw new Error(
      `Frontmatter slug "${declaredSlug}" does not match path-derived slug ` +
      `"${expectedSlug}" (from ${opts.relativePath}). Remove the frontmatter ` +
      `"slug:" line or move the file.`,
    );
  }

  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : inferTitle(opts.relativePath);

  const sourceType = typeof frontmatter.source === 'string' && frontmatter.source.trim()
    ? frontmatter.source.trim()
    : inferSourceType(opts.relativePath);

  // Strip fields that live on their own columns. Keep everything else.
  delete frontmatter.slug;
  delete frontmatter.title;
  delete frontmatter.source;

  return {
    slug: expectedSlug,
    sourceType,
    title,
    compiled_truth: body.trim(),
    timeline: '',
    frontmatter,
  };
}

/**
 * Convert a filesystem path to a stable slug.
 * "sources/claude-conversations/2026-03-08-foo.md" -> "sources/claude-conversations/2026-03-08-foo"
 */
export function slugifyPath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\.mdx?$/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function inferSourceType(relativePath: string): string {
  const lower = ('/' + relativePath.toLowerCase()).replace(/\\/g, '/');
  if (lower.includes('/claude-conversations/')) return 'claude-conversation';
  if (lower.includes('/claude-projects/'))      return 'claude-project';
  if (lower.includes('/claude-memories/'))      return 'claude-memory';
  if (lower.includes('/obsidian-imports/'))     return 'obsidian-import';
  if (lower.includes('/pdfs/'))                 return 'pdf';
  if (lower.includes('/voice-memos/'))          return 'voice-memo';
  if (lower.includes('/concepts/'))             return 'concept';
  if (lower.includes('/people/'))               return 'person';
  if (lower.includes('/deals/'))                return 'deal';
  if (lower.includes('/decisions/'))            return 'decision';
  if (lower.includes('/frameworks/'))           return 'framework';
  if (lower.includes('/open-questions/'))       return 'open-question';
  return 'note';
}

function inferTitle(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const filename = parts[parts.length - 1] ?? 'Untitled';
  const stem = filename.replace(/\.mdx?$/i, '');
  return stem.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
