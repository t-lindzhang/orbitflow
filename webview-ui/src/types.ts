// Shared types between extension and webview.
//
// The wire/protocol types (what the extension actually sends) live in the
// extension's src/types.ts and are re-exported here so there is ONE source of
// truth for the protocol. The view-model types below (Task/TreeNode/
// FocusTreeState) are webview-only shapes DERIVED from the wire types by
// convertState() in hooks/useVSCodeAPI.ts.
export type {
  NodeType,
  PriorityItem,
  ThoughtNode,
  OrbitState,
  Tree,
} from '../../src/types';
import type { NodeType, PriorityItem } from '../../src/types';

export interface CodeSnapshot {
  file: string;
  startLine: number;
  lines: string[];
  highlightedLines: number[];
}

export interface Task {
  id: string;
  name: string;
  files: string[];
  createdAt: number;
  totalTimeSpent: number;
  lastCodeSnapshot: CodeSnapshot | null;
  nodeType: NodeType;
  urgent?: boolean;
  relevance?: number; // 0-1, drives visual prominence
  detail?: string; // one-sentence description shown on cards
  waiting?: boolean; // agent finished its turn and is awaiting a prompt
  awaitingChoice?: boolean; // agent's last message just asks you to pick/confirm
  sourceId?: string; // stable external id (e.g. "user:..", "ado:..", "chat:..")
  done?: boolean; // node status === 'done'
}

export interface TreeNode {
  id: string;
  taskId: string;
  parentId: string | null;
  children: string[];
  startedAt: number;
  endedAt: number | null;
  state: 'active' | 'recent' | 'stale';
}

export interface FocusTreeState {
  tasks: Record<string, Task>;
  nodes: Record<string, TreeNode>;
  rootNodeId: string | null;
  activeNodeId: string | null;
  priority?: PriorityItem[];
  baseColor?: string; // Tree's base color (e.g., "#c77dff")
}
