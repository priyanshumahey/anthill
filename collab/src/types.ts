/**
 * Shared types for the Anthill agent-bridge protocol.
 *
 * The bridge is the HTTP surface that lets external agents (Claude Code,
 * Copilot, our own backend agents, …) read and mutate a live document
 * without going through the WebSocket / Plate editor stack.
 *
 * Modeled after proof-sdk's mutation contract: block-level ops, stable
 * refs, content-hash precondition, idempotency keys, agent-tagged
 * provenance. v1 keeps the surface intentionally small.
 */

export const PROTOCOL_VERSION = 'anthill-agent-bridge/1';
export const BRIDGE_VERSION = '0.1.0';

/** Plate node — kept loose so we don't drag the Plate type system into Bun. */
export type PlateLeaf = { text: string } & Record<string, unknown>;
export interface PlateBlock {
  type: string;
  children: (PlateLeaf | PlateBlock)[];
  [key: string]: unknown;
}
export type PlateValue = PlateBlock[];

/** Block as exposed to agents — flat, with a stable ref. */
export interface SnapshotBlock {
  /** Stable ref of the form `b1`, `b2`, … (1-based ordinal). */
  ref: string;
  /** Plate node `type` (e.g. `p`, `h1`, `blockquote`). */
  type: string;
  /** Plain-text preview (concatenation of all text leaves). */
  text: string;
  /** Element attrs (everything except `type` / `children`). */
  attrs: Record<string, unknown>;
  /** Provenance, when set on the block. */
  proof?: { author?: string; runId?: string };
}

export interface SnapshotResponse {
  documentId: string;
  title: string | null;
  /** Opaque content-hash token; pass it back as `baseRevision` on edits. */
  baseRevision: string;
  /** Number of top-level blocks. */
  blockCount: number;
  blocks: SnapshotBlock[];
  /** Whether at least one human/editor client is currently connected. */
  hasLiveClients: boolean;
}

export interface StateResponse {
  documentId: string;
  title: string | null;
  baseRevision: string;
  /** Full Plate value (top-level blocks only — same depth as `snapshot`). */
  value: PlateValue;
}

// ---------- Edit operations ----------

export interface AppendBlocksOp {
  type: 'appendBlocks';
  blocks: PlateBlock[];
}

export interface InsertBlocksAfterOp {
  type: 'insertBlocksAfter';
  /** Stable ref of an existing block (e.g. `b3`). */
  afterRef: string;
  blocks: PlateBlock[];
}

export interface InsertBlocksBeforeOp {
  type: 'insertBlocksBefore';
  beforeRef: string;
  blocks: PlateBlock[];
}

export interface ReplaceBlockOp {
  type: 'replaceBlock';
  ref: string;
  blocks: PlateBlock[];
}

export interface DeleteBlockOp {
  type: 'deleteBlock';
  ref: string;
}

export interface SetBlockTextOp {
  type: 'setBlockText';
  ref: string;
  /** Plain text — replaces all children with a single unformatted leaf. */
  text: string;
}

export interface SetTitleOp {
  type: 'setTitle';
  title: string;
}

export type EditOp =
  | AppendBlocksOp
  | InsertBlocksAfterOp
  | InsertBlocksBeforeOp
  | ReplaceBlockOp
  | DeleteBlockOp
  | SetBlockTextOp
  | SetTitleOp;

export const EDIT_OP_TYPES = [
  'appendBlocks',
  'insertBlocksAfter',
  'insertBlocksBefore',
  'replaceBlock',
  'deleteBlock',
  'setBlockText',
  'setTitle',
] as const;

export interface EditRequest {
  /** Optional precondition. If set and stale, returns 409 STALE_REVISION. */
  baseRevision?: string;
  ops: EditOp[];
}

export interface EditResponse {
  applied: number;
  baseRevision: string;
  blockCount: number;
  /** Echoes back any new refs created by the ops, in order. */
  newRefs: string[];
}

// ---------- Bridge errors ----------

export type BridgeErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_REVISION'
  | 'BLOCK_REF_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY'
  | 'INTERNAL_ERROR';

export interface BridgeErrorBody {
  error: BridgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ---------- Agent identity ----------

export interface AgentIdentity {
  /** e.g. `literature_search`, `claude-code`. */
  agentId: string;
  /** Human-friendly name (optional, used for presence). */
  agentName?: string;
  /** Optional run id from the backend agent runtime — for tracing. */
  runId?: string;
}

/** Internal origin tag stamped on every Yjs transaction triggered by the bridge. */
export interface BridgeOrigin {
  source: 'agent-bridge';
  agentId: string;
  runId?: string;
  idempotencyKey?: string;
}

// ---------- Discovery ----------

export interface DiscoveryDoc {
  protocol: typeof PROTOCOL_VERSION;
  version: typeof BRIDGE_VERSION;
  auth: {
    header: 'X-Agent-Token';
    type: 'shared-secret';
  };
  identity: { header: 'X-Agent-Id' };
  endpoints: {
    snapshot: string;
    state: string;
    edit: string;
    presence: string;
  };
  ops: readonly string[];
  /** Block types the bridge is comfortable round-tripping. */
  blockTypes: readonly string[];
}

/** Block types we explicitly support for round-trip serialization in v1. */
export const SUPPORTED_BLOCK_TYPES = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'hr',
  'code_block',
] as const;
