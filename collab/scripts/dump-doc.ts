/**
 * Diagnostic: dump the raw Yjs structure stored in Supabase for one doc.
 * Run with `bun run scripts/dump-doc.ts <documentId>`.
 *
 * Prints every fragment present on the doc + the JSON tree of each
 * top-level node so we can see exactly what Plate's slate-yjs encoding
 * is laying down (and where our snapshot walker is missing data).
 */

import { createClient } from '@supabase/supabase-js';
import * as Y from 'yjs';

const id = process.argv[2];
if (!id) {
  console.error('Usage: bun run scripts/dump-doc.ts <documentId>');
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
  .select('id, title, yjs_state, plain_text')
  .eq('id', id)
  .maybeSingle();

if (error) {
  console.error('supabase error:', error.message);
  process.exit(1);
}
if (!data) {
  console.error(`no row for ${id}`);
  process.exit(1);
}

console.log('title:', data.title);
console.log('plain_text:', JSON.stringify(data.plain_text));
console.log('yjs_state length:', (data.yjs_state as string | null)?.length ?? 0);

if (!data.yjs_state) {
  console.log('— no yjs_state stored —');
  process.exit(0);
}

const doc = new Y.Doc();
const bytes = Buffer.from(data.yjs_state as string, 'base64');
Y.applyUpdate(doc, new Uint8Array(bytes));

console.log('\n--- doc.share keys ---');
for (const [name, type] of doc.share.entries()) {
  console.log(`  ${name}  →  ${type.constructor.name}`);
}

const fragmentName = 'content';
const fragment = doc.getXmlFragment(fragmentName);
console.log(`\n--- fragment "${fragmentName}" ---`);
console.log('  length (XML node count):', fragment.length);
console.log('  toString():\n' + fragment.toString());

console.log('\n--- top-level children types ---');
const arr = fragment.toArray();
for (let i = 0; i < arr.length; i++) {
  const child = arr[i];
  console.log(
    `  [${i}] ${child.constructor.name}` +
      (child instanceof Y.XmlElement
        ? ` nodeName=${child.nodeName} attrs=${JSON.stringify(child.getAttributes())}`
        : ''),
  );
  if (child instanceof Y.XmlElement) {
    const inner = child.toArray();
    for (let j = 0; j < inner.length; j++) {
      const ic = inner[j];
      let extra = '';
      if (ic instanceof Y.XmlText) {
        try {
          extra = ` toString=${JSON.stringify(ic.toString())}`;
        } catch (e) {
          extra = ` (toString failed: ${(e as Error).message})`;
        }
      } else if (ic instanceof Y.XmlElement) {
        extra = ` nodeName=${ic.nodeName}`;
      }
      console.log(`      [${j}] ${ic.constructor.name}${extra}`);
    }
  }
}

process.exit(0);
