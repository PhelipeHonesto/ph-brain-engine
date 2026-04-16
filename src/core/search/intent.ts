/**
 * Zero-latency query intent classifier.
 * Ported from gbrain (src/core/search/intent.ts).
 *
 * No LLM call, no API cost — pure regex pattern matching. Maps query intent
 * onto a recommended detail level for hybrid search. In phase 1 we keep the
 * classifier for future use but do not yet consume its output inside the
 * search pipeline (there is no chunk_source filter in the SQL layer yet).
 */

export type QueryIntent = 'entity' | 'temporal' | 'event' | 'general';

const TEMPORAL_PATTERNS = [
  /\bwhen\b/i,
  /\blast\s+(met|meeting|call|conversation|chat|talked|spoke|seen|heard|time)\b/i,
  /\brecent(ly)?\b/i,
  /\bhistory\b/i,
  /\btimeline\b/i,
  /\bmeeting\s+notes?\b/i,
  /\bwhat('s| is| was)\s+new\b/i,
  /\blatest\b/i,
  /\bupdate(s)?\s+(on|from|about)\b/i,
  /\bhow\s+long\s+(ago|since)\b/i,
  /\b\d{4}[-/]\d{2}\b/i,
  /\blast\s+(week|month|quarter|year)\b/i,
];

const EVENT_PATTERNS = [
  /\bannounce[ds]?(ment)?\b/i,
  /\blaunch(ed|es|ing)?\b/i,
  /\braised?\s+\$?\d/i,
  /\bfund(ing|raise)\b/i,
  /\bIPO\b/i,
  /\bacquisition\b/i,
  /\bmerge[drs]?\b/i,
  /\bnews\b/i,
  /\bhappened?\b/i,
];

const ENTITY_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bwhat\s+(is|does|are)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bsummar(y|ize)\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bprofile\b/i,
  /\bwhat\s+do\s+(you|we)\s+know\b/i,
];

const FULL_CONTEXT_PATTERNS = [
  /\beverything\b/i,
  /\ball\s+(about|info|information|details)\b/i,
  /\bfull\s+(history|context|picture|story|details)\b/i,
  /\bcomprehensive\b/i,
  /\bdeep\s+dive\b/i,
  /\bgive\s+me\s+everything\b/i,
];

export function classifyQueryIntent(query: string): QueryIntent {
  if (FULL_CONTEXT_PATTERNS.some(p => p.test(query))) return 'temporal';
  if (TEMPORAL_PATTERNS.some(p => p.test(query))) return 'temporal';
  if (EVENT_PATTERNS.some(p => p.test(query))) return 'event';
  if (ENTITY_PATTERNS.some(p => p.test(query))) return 'entity';
  return 'general';
}
