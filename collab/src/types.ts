export const PROTOCOL_VERSION = 'anthill-agent-bridge/1';
export const BRIDGE_VERSION = '0.1.0';

export type PlateLeaf = { text: string } & Record<string, unknown>;
export interface PlateBlock {
  type: string;
  children: (PlateLeaf | PlateBlock)[];
  [key: string]: unknown;
}
export type PlateValue = PlateBlock[];

export interface SnapshotBlock {
  ref: string;
  type: string;
  text: string;
  attrs: Record<string, unknown>;
  proof?: { author?: string; runId?: string };
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
}

export interface DeleteBlockOp {
  type: 'deleteBlock';
  ref: string;
}

export interface SetBlockTextOp {
  type: 'setBlockText';
  ref: string;
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
  baseRevision?: string;
  ops: EditOp[];
}

export interface EditResponse {
  applied: number;
  baseRevision: string;
  blockCount: number;
  newRefs: string[];
}

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
