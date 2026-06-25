export type NodeType = "task" | "session" | "idea";

export type NodeStatus = "open" | "done";

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
  status: NodeStatus;
  lastActiveAt: number;
  detail: string;
  snapshot: ResumeContext;
  /** Stable external id (e.g. a Copilot session file) for dedup/update. */
  sourceId?: string;
  /** Agent session finished its turn and is idle awaiting the next prompt. */
  waiting?: boolean;
  /** Timestamp the node entered the waiting state (drives longest-waiting rank). */
  waitingSince?: number;
  /** Best-effort: the agent's last message just asks the user to pick/confirm. */
  awaitingChoice?: boolean;
  /** Active time spent, derived from the session's activity timestamps (ms). */
  activeMs?: number;
  /** User has visited this node since it last needed attention; clears flash
   *  and drops it from the priority list until it needs attention again. */
  acknowledged?: boolean;
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
  | { type: "reveal"; nodeId: string }
  | { type: "delete"; nodeId: string }
  | { type: "pruneSubtree"; nodeId: string }
  | { type: "toggleDone"; nodeId: string }
  | { type: "select"; nodeId: string }
  | { type: "revert" }
  | { type: "generateTrees" }
  | { type: "reorganize" }
  | { type: "clearAll" }
  | { type: "openGraph" };

/** Messages: extension -> webview */
export interface PriorityItem {
  id: string;
  reason: string;
}
export type OutboundMessage = {
  type: "state";
  state: OrbitState;
  priority: PriorityItem[];
};
