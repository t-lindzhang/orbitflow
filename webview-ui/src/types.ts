// Shared types between extension and webview
export interface CodeSnapshot {
  file: string;
  startLine: number;
  lines: string[];
  highlightedLines: number[];
}

export type NodeType = 'task' | 'session' | 'idea';

export interface Task {
  id: string;
  name: string;
  files: string[];
  createdAt: number;
  totalTimeSpent: number;
  lastCodeSnapshot: CodeSnapshot | null;
  nodeType: NodeType;
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
}
