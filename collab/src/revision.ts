import * as Y from 'yjs';

const PREFIX = 'rev1_';

export function computeRevision(doc: Y.Doc): string {
  const sv = Y.encodeStateVector(doc);
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
