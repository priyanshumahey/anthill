/**
 * Anthill collaborative editing server.
 *
 * Hocuspocus + Yjs. One Yjs document per `documents.id` row.
 * State is persisted as base64 in `documents.yjs_state` via the Supabase
 * service-role key (so RLS doesn't block the server).
 *
 * Auth model (v1, intentionally permissive):
 *   - The browser passes the Supabase user id as `token`.
 *   - We accept any non-empty token. RLS on the table still gates the REST
 *     reads/writes the Next.js app makes; the Yjs WebSocket is auxiliary.
 *
 * Tighten before production by validating a JWT minted server-side.
 */

import { Server } from '@hocuspocus/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Y from 'yjs';

const PORT = Number(process.env.COLLAB_PORT) || 8888;

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      '[collab] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Walks the Yjs XmlFragment representing the Plate document and concatenates
 * its text. Used to keep `documents.plain_text` fresh for search/embeddings.
 */
function extractPlainText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment('content');
  const out: string[] = [];

  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment) => {
    if (node instanceof Y.XmlText) {
      const s = node.toString();
      if (s) out.push(s);
      return;
    }
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        const s = child.toString();
        if (s) out.push(s);
      } else if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) {
        walk(child);
      }
    }
    if (node instanceof Y.XmlElement) out.push('\n');
  };

  walk(fragment);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

const server = new Server({
  port: PORT,
  name: 'anthill-collab',

  async onConnect({ documentName, requestHeaders }) {
    console.log(
      `[collab] connect doc=${documentName} origin=${requestHeaders.origin ?? 'unknown'}`,
    );
  },

  async onAuthenticate({ token, documentName }) {
    if (!token) {
      console.warn(`[collab] reject doc=${documentName} (no token)`);
      throw new Error('Authentication required');
    }
    return { userId: token };
  },

  async onLoadDocument({ documentName, document }) {
    try {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from('documents')
        .select('yjs_state')
        .eq('id', documentName)
        .maybeSingle();

      if (error) {
        console.warn(`[collab] load failed doc=${documentName}: ${error.message}`);
        return;
      }
      if (!data) {
        console.log(`[collab] no row for doc=${documentName} — empty state`);
        return;
      }
      if (data.yjs_state) {
        const bytes = Buffer.from(data.yjs_state as string, 'base64');
        Y.applyUpdate(document, new Uint8Array(bytes));
        console.log(`[collab] loaded doc=${documentName} (${bytes.length}B)`);
      } else {
        console.log(`[collab] doc=${documentName} has no yjs_state — first connect`);
      }
    } catch (err) {
      console.error(`[collab] error loading doc=${documentName}:`, err);
    }
  },

  async onStoreDocument({ documentName, document }) {
    try {
      const supabase = getSupabaseAdmin();
      const state = Y.encodeStateAsUpdate(document);
      const base64 = Buffer.from(state).toString('base64');
      const plainText = extractPlainText(document);

      const { error } = await supabase
        .from('documents')
        .update({
          yjs_state: base64,
          plain_text: plainText,
          updated_at: new Date().toISOString(),
        })
        .eq('id', documentName);

      if (error) {
        console.error(`[collab] store failed doc=${documentName}: ${error.message}`);
      } else {
        console.log(`[collab] stored doc=${documentName} (${state.length}B)`);
      }
    } catch (err) {
      console.error(`[collab] error storing doc=${documentName}:`, err);
    }
  },

  async onDisconnect({ documentName }) {
    console.log(`[collab] disconnect doc=${documentName}`);
  },

  async onListen({ port }) {
    console.log(`[collab] listening ws://localhost:${port}`);
  },
});

server.listen();
