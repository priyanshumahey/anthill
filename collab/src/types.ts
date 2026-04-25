export const PROTOCOL_VERSION = 'anthill-agent-bridge/1';
export const BRIDGE_VERSION = '0.1.0';

export type PlateLeaf = { text: string } & Record<string, unknown>;
export interface PlateBlock {
  type: string;
  children: (PlateLeaf | PlateBlock)[];
  [key: string]: unknown;
}
export type PlateValue = PlateBlock[];

export interface SnapshotInline {
  /** Inline element type, e.g. "citation". */
  type: string;
  /** Short positional marker (e.g. "[cite:arXiv:2510.00908v1]") that also
   *  appears in the block's `text` preview at the inline's location. */
  label?: string;
  /** Full attribute payload of the inline element (everything but `type`
   *  and `children`). For citations this includes `arxivId`, `chunkIndex`,
   *  `title`, `score`, etc. */
  attrs: Record<string, unknown>;
}

export interface SnapshotBlock {
  ref: string;
  type: string;
  text: string;
  attrs: Record<string, unknown>;
  proof?: { author?: string; runId?: string };
  /** Inline element children (citations, mentions, ...) attached to this
   *  block. Present only when the block has at least one such child.
   *  Agents MUST treat these as preserved-by-default across destructive
   *  edits unless they explicitly pass `dropInlineElements: true`. */
  inlines?: SnapshotInline[];
}

export interface SnapshotResponse {
  documentId: string;
  title: string | null;
  baseRevision: string;
  blockCount: number;
  blocks: SnapshotBlock[];
  hasLiveClients: boolean;
}

export interface StateResponse {
  documentId: string;
  title: string | null;
  baseRevision: string;
  value: PlateValue;
}

export interface AppendBlocksOp {
  type: 'appendBlocks';
  blocks: PlateBlock[];
}

export interface InsertBlocksAfterOp {
  type: 'insertBlocksAfter';
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
  /** Opt out of citation/inline preservation. Default false: any inline
   *  elements on the original block are appended to the last new block. */
  dropInlineElements?: boolean;
}

export interface DeleteBlockOp {
  type: 'deleteBlock';
  ref: string;
  /** Opt out of the citation guard. Default false: deleting a block that
   *  carries inline citations fails with INLINE_ELEMENTS_WOULD_BE_LOST. */
  dropInlineElements?: boolean;
}

export interface SetBlockTextOp {
  type: 'setBlockText';
  ref: string;
  text: string;
  /** Opt out of inline preservation. Default false: existing inline
   *  elements (citations, etc.) are kept, appended after the new text. */
  dropInlineElements?: boolean;
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
  baseRevision?: string;
  ops: EditOp[];
}

export interface EditResponse {
  applied: number;
  baseRevision: string;
  blockCount: number;
  newRefs: string[];
  /** Number of inline elements (citations, ...) auto-preserved across
   *  destructive ops in this batch. 0 when nothing needed preserving. */
  preservedInlines?: number;
}

export type BridgeErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_REVISION'
  | 'BLOCK_REF_NOT_FOUND'
  | 'INLINE_ELEMENTS_WOULD_BE_LOST'
  | 'IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY'
  | 'INTERNAL_ERROR';

export interface BridgeErrorBody {
  error: BridgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentIdentity {
  agentId: string;
  agentName?: string;
  runId?: string;
}

export interface BridgeOrigin {
  source: 'agent-bridge';
  agentId: string;
  runId?: string;
  idempotencyKey?: string;
}

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
  blockTypes: readonly string[];
}

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
