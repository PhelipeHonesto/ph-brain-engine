/**
 * Voyage AI embedding client.
 *
 * voyage-3-large at 2048 dimensions. The `input_type` parameter is load-bearing:
 * Voyage produces *different vectors for the same text* depending on whether it
 * is being embedded as a "document" (for indexing) or a "query" (for retrieval).
 * Mixing these types collapses retrieval quality. We make it a required
 * argument on every call to prevent accidental misuse.
 *
 * Reference: https://docs.voyageai.com/reference/embeddings-api
 */

export type VoyageInputType = 'document' | 'query';

export interface VoyageOptions {
  model?: string;
  dimensions?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MODEL = process.env.VOYAGE_MODEL ?? 'voyage-3-large';
const DEFAULT_DIMENSIONS = Number(process.env.VOYAGE_DIMENSIONS ?? 2048);

// Voyage accepts up to 32k tokens per input for voyage-3-large, but we cap
// at ~32000 characters (~8k tokens) per chunk. Individual chunks from our
// recursive chunker are ~300 words so this is a defensive upper bound.
const MAX_CHARS = 32_000;

// Batch size ceiling. Voyage allows up to 128 inputs per request.
const BATCH_SIZE = 128;

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY = 2_000;
const DEFAULT_MAX_DELAY = 60_000;

/** Embed a single string. */
export async function embed(
  text: string,
  inputType: VoyageInputType,
  opts?: VoyageOptions,
): Promise<Float32Array> {
  const [out] = await embedBatch([text], inputType, opts);
  if (!out) throw new Error('Voyage returned no embedding');
  return out;
}

/** Embed multiple strings. Output order matches input order. */
export async function embedBatch(
  texts: string[],
  inputType: VoyageInputType,
  opts?: VoyageOptions,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch, inputType, opts);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  inputType: VoyageInputType,
  opts?: VoyageOptions,
): Promise<Float32Array[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not set. Get a key at https://www.voyageai.com/');
  }

  const model = opts?.model ?? DEFAULT_MODEL;
  const dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY;
  const maxDelay = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts,
          input_type: inputType,
          output_dimension: dimensions,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        const err = new VoyageError(response.status, body);
        if (isRetryable(response.status) && attempt < maxRetries - 1) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          const delay = !isNaN(retryAfter)
            ? retryAfter * 1000
            : exponentialDelay(attempt, baseDelay, maxDelay);
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const json = await response.json() as VoyageResponse;
      if (!Array.isArray(json.data)) {
        throw new Error('Voyage response missing `data` array');
      }

      // Preserve request order via the `index` field
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e) {
      if (e instanceof VoyageError) throw e;
      if (attempt === maxRetries - 1) throw e;
      await sleep(exponentialDelay(attempt, baseDelay, maxDelay));
    }
  }

  throw new Error('embedBatchWithRetry exhausted retries without returning');
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function exponentialDelay(attempt: number, base: number, cap: number): number {
  return Math.min(base * Math.pow(2, attempt), cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class VoyageError extends Error {
  constructor(public status: number, public body: string) {
    super(`Voyage API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'VoyageError';
  }
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { total_tokens: number };
}

export const MODEL = DEFAULT_MODEL;
export const DIMENSIONS = DEFAULT_DIMENSIONS;
