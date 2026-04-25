import { createClient } from '@supabase/supabase-js';
import * as Y from 'yjs';

import { getContentFragment, pruneIllegalChildren } from '../src/plate-yjs';

const id = process.argv[2];
const dryRun = process.argv.includes('--dry');
if (!id) {
  console.error('Usage: bun run scripts/cleanup-doc.ts <documentId> [--dry]');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase
  .from('documents')
  .select('id, title, yjs_state')
  .eq('id', id)
  .maybeSingle();

if (error) {
  console.error('supabase read error:', error.message);
  process.exit(1);
}
if (!data) {
  console.error(`no row for ${id}`);
  process.exit(1);
}

console.log(`title: ${data.title}`);
if (!data.yjs_state) {
  console.log('— no yjs_state stored, nothing to clean —');
  process.exit(0);
}

const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(Buffer.from(data.yjs_state as string, 'base64')));

const fragment = getContentFragment(doc);
const before = fragment.toArray();
let strays = 0;
for (const c of before) {
  if (!(c instanceof Y.XmlText)) strays++;
}
console.log(`top-level children: ${before.length} (${strays} stray Y.XmlElement)`);

if (strays === 0) {
  console.log('clean already; nothing to do');
  process.exit(0);
}

let removed = 0;
Y.transact(doc, () => {
  removed = pruneIllegalChildren(fragment);
});
console.log(`pruned ${removed} stray node(s)`);

if (dryRun) {
  console.log('--dry, not writing');
  process.exit(0);
}

const newState = Y.encodeStateAsUpdate(doc);
const base64 = Buffer.from(newState).toString('base64');
const { error: writeErr } = await supabase
  .from('documents')
  .update({ yjs_state: base64, updated_at: new Date().toISOString() })
  .eq('id', id);
if (writeErr) {
  console.error('supabase write error:', writeErr.message);
  process.exit(1);
}
console.log(`wrote ${newState.length}B back to documents.yjs_state`);
console.log('NOTE: connected editors are still holding the OLD CRDT state.');
console.log('They need to reload the page for the cleaned state to take effect.');
