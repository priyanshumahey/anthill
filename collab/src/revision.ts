/**
 * Content-hash based revision tokens.
 *
 * We deliberately do NOT use timestamps — clock skew + concurrent edits
 * make them unreliable. Instead we hash the Yjs state vector, which
 * uniquely identifies the doc's logical state. Same idea proof-sdk's
 * `mt1_*` tokens use.
 */

import * as Y from 'yjs';

const PREFIX = 'rev1_';

export function computeRevision(doc: Y.Doc): string {
  // State vector is stable for a given logical state across peers.
  const sv = Y.encodeStateVector(doc);
  // FNV-1a 64-bit (good enough for opaque tokens, no crypto need).
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < sv.length; i++) {
    h1 = ((h1 ^ sv[i]) * 0x01000193) >>> 0;
    h2 = ((h2 ^ sv[i]) * 0x01000193) >>> 0;
    if (i % 3 === 0) h2 = (h2 + h1) >>> 0;
  }
  return PREFIX + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function isRevisionToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
