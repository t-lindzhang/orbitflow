export type NodeType = "task" | "session" | "idea";

export interface ResumeContext {
  /** Files that were open, with optional cursor line for the active one. */
  files: { path: string; line?: number; active?: boolean }[];
  /** Recently seen terminal commands. */
  terminalCommands: string[];
}

export interface ThoughtNode {
  id: string;
  treeId: string;
  parentId: string | null;
  title: string;
  type: NodeType;
  /** 0..1 — drives color saturation. */
  relevance: number;
  urgent: boolean;
  lastActiveAt: number;
  detail: string;
  snapshot: ResumeContext;
}

export interface Tree {
  id: string;
  title: string;
  baseColor: string;
  createdAt: number;
}

export interface OrbitState {
  trees: Tree[];
  nodes: ThoughtNode[];
  /** The node a newly captured node will attach to, per tree. */
  activeNodeId: string | null;
  activeTreeId: string | null;
}

/** Messages: webview -> extension */
export type InboundMessage =
  | { type: "ready" }
  | { type: "resume"; nodeId: string }
  | { type: "delete"; nodeId: string }
  | { type: "select"; nodeId: string }
  | { type: "newTree" }
  | { type: "captureNode" };

/** Messages: extension -> webview */
export type OutboundMessage = { type: "state"; state: OrbitState };
