/**
 * Seed an example research paper into the local stack.
 *
 * What it does
 * ────────────
 *   1. Inserts a `documents` row in Supabase (service-role, bypasses RLS).
 *   2. Drives the agent bridge HTTP API (`/documents/{id}/edit`) to append
 *      the paper section by section.
 *   3. After each prose paragraph, hits the FastAPI semantic-search
 *      backend (`POST /search`) with that paragraph's text, applies the
 *      same hit-selection rules the in-editor citation-suggest plugin
 *      uses (minScore / scoreGap / maxInsert / dedupe by arXiv id), and
 *      rewrites the block with `replaceBlock` so the same prose now
 *      carries one or more inline `citation` elements.
 *   4. Waits past Hocuspocus's persistence debounce, then prints the
 *      dashboard URL.
 *
 * Why this path
 * ─────────────
 * Yjs is the source of truth for live content; the editor never reads
 * `documents.content` once it's connected. Writing this seed *through*
 * the agent bridge means the edits go through Hocuspocus → Yjs CRDT →
 * `onStoreDocument` → Supabase `yjs_state`, which is the same path any
 * real collaborator (or agent) takes. Anyone with the doc open during
 * seeding sees it appear paragraph-by-paragraph in real time.
 *
 * Prereqs (all running locally)
 *   - Supabase           (`supabase start`)
 *   - Hocuspocus + bridge(`bun run dev` in /collab)
 *   - FastAPI backend    (`uv run fastapi dev` in /backend)
 *
 * Usage
 *   bun run scripts/seed-example-paper.ts
 *   bun run scripts/seed-example-paper.ts --owner-id <uuid>
 *   bun run scripts/seed-example-paper.ts --doc-id <uuid>   # re-seed existing
 *   bun run scripts/seed-example-paper.ts --no-citations    # skip /search
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

// ── Config ────────────────────────────────────────────────────────────────

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BRIDGE_URL = (
  process.env.AGENT_BRIDGE_URL ??
  process.env.NEXT_PUBLIC_AGENT_BRIDGE_URL ??
  'http://localhost:8889'
).replace(/\/+$/, '');
const BRIDGE_SECRET = process.env.ANTHILL_AGENT_BRIDGE_SECRET ?? '';
const BACKEND_URL = (
  process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'
).replace(/\/+$/, '');
const BACKEND_SECRET = process.env.ANTHILL_SHARED_SECRET ?? '';

const AGENT_ID = 'seed-example-paper';
const AGENT_NAME = 'Example paper seeder';

// Mirror the editor's CitationSuggestPlugin defaults.
const SEARCH_K = 5;
const MIN_SCORE = 0.55;
const SCORE_GAP = 0.08;
const MAX_INSERT = 3;

// Hocuspocus default debounce is 2s; give it a buffer.
const PERSIST_WAIT_MS = 5000;

// ── CLI ───────────────────────────────────────────────────────────────────

interface CliArgs {
  docId?: string;
  ownerId?: string;
  noCitations: boolean;
  title?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { noCitations: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--doc-id':
        out.docId = argv[++i];
        break;
      case '--owner-id':
        out.ownerId = argv[++i];
        break;
      case '--title':
        out.title = argv[++i];
        break;
      case '--no-citations':
        out.noCitations = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }
  return out;
}

function printHelp() {
  console.log(
    'Usage: bun run scripts/seed-example-paper.ts [--doc-id <uuid>] [--owner-id <uuid>] [--title "..."] [--no-citations]',
  );
}

// ── Bridge / search types ─────────────────────────────────────────────────

interface BridgeEditOp {
  type:
    | 'appendBlocks'
    | 'insertBlocksAfter'
    | 'insertBlocksBefore'
    | 'replaceBlock'
    | 'deleteBlock'
    | 'setBlockText'
    | 'setTitle';
  // Loose-typed because we drive every op shape from this script.
  [key: string]: unknown;
}

interface BridgeEditResponse {
  applied: number;
  baseRevision: string;
  blockCount: number;
  newRefs: string[];
  preservedInlines?: number;
}

interface BackendHit {
  arxiv_id: string;
  chunk_index: number;
  text: string;
  score: number;
  title?: string | null;
  char_start?: number | null;
  char_end?: number | null;
}

interface BackendSearchResponse {
  query: string;
  hits: BackendHit[];
  took_ms: number;
}

interface CitationCandidate {
  arxivId: string;
  chunkIndex: number;
  title?: string | null;
  score: number;
  snippet?: string | null;
}

// Plate block / leaf — kept loose so we can mix headings, paragraphs and
// inline void elements (citations) freely.
type Leaf = { text: string };
type InlineEl = Record<string, unknown> & {
  type: string;
  children: [Leaf];
};
type PlateBlock = Record<string, unknown> & {
  type: string;
  children: Array<Leaf | InlineEl>;
};

// ── Example paper ─────────────────────────────────────────────────────────
//
// A short survey-style paper. Topic and prose are deliberately written to
// land near the cs.AI corpus seeded by /datasets — dense retrieval, RAG,
// hallucinations, in-context learning, reranking — so the citation
// suggester finds substantive hits.

const PAPER_TITLE =
  'Anchored Generation: A Survey of Retrieval-Augmented Methods for Scientific Writing';

interface Section {
  heading: { type: 'h1' | 'h2' | 'h3'; text: string };
  paragraphs: string[];
}

const PAPER: Section[] = [
  {
    heading: { type: 'h1', text: PAPER_TITLE },
    paragraphs: [
      'Abstract. Large language models can produce fluent scientific prose but are notoriously unreliable when asked to make verifiable factual claims. Retrieval-augmented generation (RAG) couples a generator with a dense passage retriever so that each generated sentence can be conditioned on, and traced back to, primary sources. In this survey we organise the design space of retrieval-augmented systems for scientific writing along three axes — index construction, retrieval and reranking, and grounded generation — and argue that future systems should expose retrieval traces directly in the editor surface, treating provenance as a first-class artefact rather than a post-hoc citation list.',
    ],
  },
  {
    heading: { type: 'h2', text: '1. Introduction' },
    paragraphs: [
      'Modern language models trained on web-scale corpora have been shown to hallucinate plausible but unsupported claims, especially in long-form generation tasks where evaluators cannot easily check every assertion. The risk is acute in scientific writing because a single fabricated citation can propagate through downstream literature, and because reviewers are increasingly skeptical of generated text. Grounding generation in a retrieved set of authoritative passages is the most widely adopted mitigation, and dense retrieval over neural embeddings has displaced lexical baselines for most academic search workloads.',
      'A retrieval-augmented system for scientific writing differs from open-domain question answering in three important ways. First, the corpus is small and high-quality — a curated set of papers in a sub-field rather than the open web — which changes the trade-off between recall and latency. Second, the unit of retrieval is typically a passage or chunk inside a paper, not a whole document, because authors cite specific claims and not whole works. Third, the editor surface itself can act as part of the retrieval loop: the cursor is a strong signal of what the user is currently writing about, so the system can issue queries proactively without an explicit search step.',
    ],
  },
  {
    heading: { type: 'h2', text: '2. Index Construction' },
    paragraphs: [
      'Most production retrieval pipelines today embed paper passages with a bi-encoder trained with contrastive losses, then index the resulting vectors in an approximate nearest-neighbour structure such as HNSW or IVF-PQ. The choice of chunking strategy materially affects retrieval quality: fixed-size token windows are simple but split arguments awkwardly, whereas semantically aware splitters that respect section and sentence boundaries tend to produce more answerable passages. For a scientific corpus, retaining the originating section header alongside the chunk text gives the embedder a useful disambiguating signal at almost no additional cost.',
      'Embedding models trained explicitly on scientific text — using either domain-adaptive pretraining or instruction tuning over scientific question–answer pairs — consistently outperform general-purpose encoders on scholarly retrieval benchmarks. Recent open-source models in the 100M to 1B parameter range close most of the gap to proprietary embedders while remaining cheap enough to run on a single GPU, which makes a fully local pipeline viable for academic deployments where sending paper text to third-party APIs is not acceptable.',
    ],
  },
  {
    heading: { type: 'h2', text: '3. Retrieval and Reranking' },
    paragraphs: [
      'A typical two-stage pipeline first retrieves a few hundred candidates with a fast bi-encoder and then reranks the shortlist with a more expensive cross-encoder. The cross-encoder concatenates the query and each candidate, which lets the model attend across both, and routinely lifts top-k precision by ten to twenty points relative to the first-stage retriever alone. Recent work has shown that even modestly sized large language models can be prompted to act as listwise rerankers, sometimes outperforming dedicated cross-encoders on novel query distributions, at the cost of much higher latency.',
      'For interactive systems the latency budget matters as much as the absolute ranking quality. Caching first-stage results across nearby queries, batching the rerank step, and aborting in-flight requests as soon as the user resumes typing are all standard tricks. When latency is the dominant constraint, skipping the reranker entirely and relying on a high-recall first-stage retriever is often acceptable, especially when the user is shown several candidates and ultimately chooses which to cite.',
    ],
  },
  {
    heading: { type: 'h2', text: '4. Grounded Generation' },
    paragraphs: [
      'Once relevant passages have been retrieved, the generator must produce text that is faithful to them. The simplest approach concatenates the top-k passages into the prompt and asks the model to answer using only the provided context, but in practice models still drift outside the retrieved evidence, especially when the passages do not fully cover the question. Constrained decoding strategies such as attribution-aware sampling and post-hoc faithfulness verification can reduce, though not eliminate, this drift.',
      'In-context learning, in which a few demonstrations are placed in the prompt to steer the model, has been observed to emerge sharply with model scale and is particularly useful for citation insertion tasks where the desired behaviour is hard to describe in natural language. A small set of high-quality demonstration paragraphs paired with their target citations is often enough to align the generator with a particular citation style without any additional fine-tuning.',
    ],
  },
  {
    heading: { type: 'h2', text: '5. Discussion' },
    paragraphs: [
      'A retrieval-augmented writing tool is most useful when the act of citation is reduced from a manual lookup to a single keystroke. Surfacing each candidate alongside the score, the matched passage, and the runners-up that the system considered makes the agent\u2019s reasoning inspectable, which in turn makes its mistakes easy to catch. Treating the citation as a first-class document object — not as plain markdown — also lets downstream tools render bibliographies, deduplicate references, and export to LaTeX without re-parsing prose.',
      'Open problems remain. Reranking with proprietary frontier models is expensive and offline-incompatible. Citation grounding at the level of exact quoted text — as opposed to the level of the cited paper — requires storing character offsets through the entire pipeline, which most existing tools do not. Finally, evaluation of retrieval-augmented writing is still mostly qualitative; we lack a benchmark that measures both factual accuracy and writing quality jointly on realistic long-form drafts.',
    ],
  },
  {
    heading: { type: 'h2', text: '6. Conclusion' },
    paragraphs: [
      'We surveyed the design space of retrieval-augmented systems for scientific writing across three axes — indexing, retrieval and reranking, and grounded generation. The pieces are individually mature, and the remaining engineering work is largely about plumbing them together inside a collaborative editor that treats provenance as a first-class artefact. Done well, such a tool changes the writing experience from "type, then chase down references" to "type, accept the suggested reference, keep typing".',
    ],
  },
];

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function bridgeEdit(
  documentId: string,
  ops: BridgeEditOp[],
): Promise<BridgeEditResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-agent-id': AGENT_ID,
    'x-agent-name': AGENT_NAME,
  };
  if (BRIDGE_SECRET) headers['x-agent-token'] = BRIDGE_SECRET;

  const res = await fetch(
    `${BRIDGE_URL}/documents/${encodeURIComponent(documentId)}/edit`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ ops }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `bridge edit ${res.status}: ${detail.slice(0, 400) || res.statusText}`,
    );
  }
  return (await res.json()) as BridgeEditResponse;
}

async function bridgeHealth(): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/healthz`);
  if (!res.ok) {
    throw new Error(
      `agent bridge unreachable at ${BRIDGE_URL} (status ${res.status}). Is collab running? bun run dev in /collab`,
    );
  }
}

async function backendHealth(): Promise<void> {
  const headers: Record<string, string> = {};
  if (BACKEND_SECRET) headers['x-anthill-secret'] = BACKEND_SECRET;
  const res = await fetch(`${BACKEND_URL}/healthz`, { headers });
  if (!res.ok) {
    throw new Error(
      `backend unreachable at ${BACKEND_URL} (status ${res.status}). Is FastAPI running? uv run fastapi dev in /backend`,
    );
  }
}

async function backendSearch(
  query: string,
  k: number,
): Promise<BackendSearchResponse | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (BACKEND_SECRET) headers['x-anthill-secret'] = BACKEND_SECRET;
  const res = await fetch(`${BACKEND_URL}/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, k }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(
      `  ! search failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`,
    );
    return null;
  }
  return (await res.json()) as BackendSearchResponse;
}

// ── Hit selection — mirrors components/editor/plugins/citation-suggest-kit ──

function selectAcceptedHits(hits: BackendHit[]): BackendHit[] {
  if (hits.length === 0) return [];
  const top = hits[0]!;
  const seen = new Set<string>();
  const picked: BackendHit[] = [];
  for (const h of hits) {
    if (picked.length >= MAX_INSERT) break;
    if (h.score < MIN_SCORE) continue;
    if (top.score - h.score > SCORE_GAP) continue;
    if (seen.has(h.arxiv_id)) continue;
    seen.add(h.arxiv_id);
    picked.push(h);
  }
  return picked;
}

// ── Plate block builders ──────────────────────────────────────────────────

function paragraphBlock(text: string): PlateBlock {
  return { type: 'p', children: [{ text }] };
}

function headingBlock(type: 'h1' | 'h2' | 'h3', text: string): PlateBlock {
  return { type, children: [{ text }] };
}

function citationInline(
  hit: BackendHit,
  query: string,
  takenMs: number,
  trace: CitationCandidate[],
  searchedAt: string,
): InlineEl {
  return {
    type: 'citation',
    arxivId: hit.arxiv_id,
    chunkIndex: hit.chunk_index,
    title: hit.title ?? null,
    score: hit.score,
    snippet: hit.text ? hit.text.slice(0, 600) : null,
    query,
    takenMs,
    searchedAt,
    trace,
    children: [{ text: '' }],
  };
}

function paragraphWithCitations(
  text: string,
  picked: BackendHit[],
  query: string,
  takenMs: number,
  searchedAt: string,
  fullHits: BackendHit[],
): PlateBlock {
  const trace: CitationCandidate[] = fullHits.map((h) => ({
    arxivId: h.arxiv_id,
    chunkIndex: h.chunk_index,
    title: h.title ?? null,
    score: h.score,
    snippet: h.text ? h.text.slice(0, 600) : null,
  }));
  const inlines = picked.map((h) =>
    citationInline(h, query, takenMs, trace, searchedAt),
  );
  // Match the in-editor flow: a leading space before each badge so it
  // renders cleanly after the prose run.
  const children: Array<Leaf | InlineEl> = [{ text: text + ' ' }];
  for (const inline of inlines) {
    children.push(inline);
    children.push({ text: ' ' });
  }
  // Trim the trailing space placeholder so the block doesn't render an
  // extra glyph after the last badge.
  const last = children[children.length - 1] as Leaf;
  if (last && typeof last.text === 'string' && last.text === ' ') {
    children.pop();
  }
  return { type: 'p', children };
}

// ── Supabase helpers ──────────────────────────────────────────────────────

function getSupabase(): SupabaseClient {
  if (!SUPABASE_KEY) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. Source /collab/.env or export it before running.',
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function ensureDocument(
  supabase: SupabaseClient,
  args: CliArgs,
): Promise<{ id: string; created: boolean }> {
  if (args.docId) {
    const { data, error } = await supabase
      .from('documents')
      .select('id')
      .eq('id', args.docId)
      .maybeSingle();
    if (error) throw new Error(`supabase read: ${error.message}`);
    if (!data) throw new Error(`document ${args.docId} not found`);
    return { id: args.docId, created: false };
  }

  const id = randomUUID();
  const title = args.title ?? PAPER_TITLE;
  const { error } = await supabase.from('documents').insert({
    id,
    title,
    content: [],
    created_by: args.ownerId ?? null,
  });
  if (error) throw new Error(`supabase insert: ${error.message}`);
  return { id, created: true };
}

// ── Main flow ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('[seed] env');
  console.log(`  supabase     ${SUPABASE_URL}`);
  console.log(`  agent bridge ${BRIDGE_URL}`);
  console.log(`  backend      ${BACKEND_URL}`);
  console.log(`  citations    ${args.noCitations ? 'OFF' : 'ON'}`);
  console.log('');

  console.log('[seed] preflight');
  await bridgeHealth();
  console.log('  agent bridge OK');
  if (!args.noCitations) {
    await backendHealth();
    console.log('  backend OK');
  }

  const supabase = getSupabase();
  const { id, created } = await ensureDocument(supabase, args);
  console.log(
    `  document ${created ? 'created' : 'reusing'} ${id}\n`,
  );

  // 1. Title.
  console.log(`[seed] setTitle "${args.title ?? PAPER_TITLE}"`);
  await bridgeEdit(id, [
    { type: 'setTitle', title: args.title ?? PAPER_TITLE },
  ]);

  // 2. Walk the paper.
  let paragraphCount = 0;
  let citationCount = 0;
  let citedParagraphs = 0;

  for (const [si, section] of PAPER.entries()) {
    console.log(`\n[seed] section ${si + 1}/${PAPER.length} — ${section.heading.text}`);
    await bridgeEdit(id, [
      {
        type: 'appendBlocks',
        blocks: [
          headingBlock(section.heading.type, section.heading.text),
        ],
      },
    ]);

    for (const [pi, text] of section.paragraphs.entries()) {
      paragraphCount++;
      console.log(`  ¶ ${pi + 1}/${section.paragraphs.length}  (${text.length} chars)`);

      // Append plain prose first so a connected editor sees it land
      // immediately, exactly like a human would type it.
      const append = await bridgeEdit(id, [
        { type: 'appendBlocks', blocks: [paragraphBlock(text)] },
      ]);
      const ref = append.newRefs[0];
      if (!ref) {
        console.warn('    ! no newRefs returned, skipping citation step');
        continue;
      }

      if (args.noCitations) continue;

      const startedAt = Date.now();
      const result = await backendSearch(text, SEARCH_K);
      const takenMs = result?.took_ms ?? Date.now() - startedAt;
      const searchedAt = new Date().toISOString();

      if (!result || result.hits.length === 0) {
        console.log('    · no hits');
        continue;
      }

      const picked = selectAcceptedHits(result.hits);
      if (picked.length === 0) {
        const top = result.hits[0]!;
        console.log(
          `    · top hit ${top.arxiv_id} ${(top.score * 100).toFixed(0)}% < threshold ${(MIN_SCORE * 100).toFixed(0)}%`,
        );
        continue;
      }

      console.log(
        `    + ${picked.length} citation(s): ${picked
          .map((h) => `${h.arxiv_id}@${h.chunk_index}/${(h.score * 100).toFixed(0)}%`)
          .join(', ')}`,
      );

      // Replace the freshly-appended block with the same prose plus
      // inline citation children. The bridge stamps it with our
      // proofAuthor in the same way agent edits get tracked.
      await bridgeEdit(id, [
        {
          type: 'replaceBlock',
          ref,
          blocks: [
            paragraphWithCitations(
              text,
              picked,
              result.query,
              takenMs,
              searchedAt,
              result.hits,
            ),
          ],
        },
      ]);
      citationCount += picked.length;
      citedParagraphs++;
    }
  }

  console.log('');
  console.log('[seed] summary');
  console.log(`  paragraphs           ${paragraphCount}`);
  console.log(`  paragraphs cited     ${citedParagraphs}`);
  console.log(`  total citations      ${citationCount}`);

  console.log(
    `\n[seed] waiting ${PERSIST_WAIT_MS}ms for Hocuspocus debounce → Supabase persistence…`,
  );
  await new Promise((r) => setTimeout(r, PERSIST_WAIT_MS));

  // Best-effort confirmation that the yjs_state landed in the row.
  const { data, error } = await supabase
    .from('documents')
    .select('title, plain_text, yjs_state')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn(`  ! could not verify persistence: ${error.message}`);
  } else if (!data?.yjs_state) {
    console.warn(
      '  ! documents.yjs_state is still empty — Hocuspocus may not have flushed yet.',
    );
  } else {
    const stateBytes = Math.ceil(((data.yjs_state as string).length * 3) / 4);
    const plainLen = (data.plain_text as string | null)?.length ?? 0;
    console.log(
      `  ✓ persisted: title="${data.title}", yjs_state≈${stateBytes}B, plain_text=${plainLen} chars`,
    );
  }

  console.log('\n[seed] done');
  console.log(`  open: http://localhost:3000/dashboard/documents/${id}`);
}

main().catch((err) => {
  console.error('\n[seed] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
