import { useState, useEffect, useCallback } from 'react';
import {
  FocusTreeState,
  Task,
  TreeNode,
  PriorityItem,
  OrbitState,
  ThoughtNode,
  Tree,
} from '../types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

interface PersistedState {
  treeState: FocusTreeState | null;
  userTasks: { id: string; text: string; done: boolean }[];
}

export function useVSCodeAPI() {
  const persisted: PersistedState = vscode.getState() || { treeState: null, userTasks: [] };
  
  const [state, setState] = useState<FocusTreeState | null>(persisted.treeState);
  const [userTasks, setUserTasks] = useState<{ id: string; text: string; done: boolean }[]>(persisted.userTasks || []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'stateUpdate' || message.type === 'state') {
        const newState = message.state;
        const priority = message.priority || [];
        const converted = convertState(newState, priority);
        setState(converted);
        vscode.setState({ treeState: converted, userTasks });
      } else if (message.type === 'userTasks') {
        // Restore user tasks from extension backend
        const tasks = message.tasks || [];
        setUserTasks(tasks);
        vscode.setState({ treeState: state, userTasks: tasks });
      }
    };
    window.addEventListener('message', handler);

    // Send "ready" message (OrbitFlow protocol)
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handler);
  }, []);

  const sendMessage = useCallback((command: string, data?: Record<string, unknown>) => {
    // Map our commands to OrbitFlow message format
    if (command === 'selectNode') {
      vscode.postMessage({ type: 'select', nodeId: data?.nodeId });
    } else if (command === 'openFullView' || command === 'openGraph') {
      vscode.postMessage({ type: 'openGraph' });
    } else if (command === 'requestState') {
      vscode.postMessage({ type: 'ready' });
    } else if (command === 'revert') {
      vscode.postMessage({ type: 'revert' });
    } else if (command === 'generateTrees') {
      vscode.postMessage({ type: 'generateTrees' });
    } else if (command === 'reorganize') {
      vscode.postMessage({ type: 'reorganize' });
    } else if (command === 'clearAll') {
      vscode.postMessage({ type: 'clearAll' });
    } else if (command === 'resume') {
      vscode.postMessage({ type: 'resume', nodeId: data?.nodeId });
    } else if (command === 'reveal') {
      vscode.postMessage({ type: 'reveal', nodeId: data?.nodeId });
    } else if (command === 'delete') {
      vscode.postMessage({ type: 'delete', nodeId: data?.nodeId });
    } else if (command === 'pruneSubtree') {
      vscode.postMessage({ type: 'pruneSubtree', nodeId: data?.nodeId });
    } else if (command === 'toggleDone') {
      vscode.postMessage({ type: 'toggleDone', nodeId: data?.nodeId });
    } else if (command === 'editNode') {
      vscode.postMessage({ type: 'editNode', nodeId: data?.nodeId, title: data?.title, detail: data?.detail });
    } else {
      vscode.postMessage({ type: command, ...data });
    }
  }, []);

  const saveUserTasks = useCallback((tasks: { id: string; text: string; done: boolean }[]) => {
    setUserTasks(tasks);
    vscode.setState({ treeState: state, userTasks: tasks });
    // Persist to extension workspaceState (survives restarts)
    vscode.postMessage({ type: 'saveUserTasks', tasks });
  }, [state]);

  return { state, sendMessage, userTasks, saveUserTasks };
}

// Convert OrbitFlow state format to our FocusTreeState format
function convertState(orbitState: any, priority: PriorityItem[] = []): FocusTreeState {
  // If it's already our format, return as-is
  if (orbitState.tasks && orbitState.nodes && !Array.isArray(orbitState.nodes)) {
    return { ...orbitState, priority };
  }

  // Otherwise it's the extension's wire format (OrbitState with arrays).
  const state = orbitState as OrbitState;
  const tasks: Record<string, Task> = {};
  const nodes: Record<string, TreeNode> = {};
  let rootNodeId: string | null = null;
  const activeNodeId: string | null = state.activeNodeId || null;

  // OrbitFlow uses arrays of ThoughtNodes
  const thoughtNodes: ThoughtNode[] = state.nodes || [];

  for (const tn of thoughtNodes) {
    // Create a Task from the ThoughtNode
    // Only show the active file (the one being edited when node was created)
    const activeFile = tn.snapshot?.files?.find((f: any) => f.active);
    const nodeFiles = activeFile ? [activeFile.path] : 
      (tn.snapshot?.files?.slice(0, 1).map((f: any) => f.path) || []);
    
    tasks[tn.id] = {
      id: tn.id,
      name: tn.title || '?',
      files: nodeFiles,
      createdAt: tn.lastActiveAt || Date.now(),
      totalTimeSpent: tn.activeMs || 0,
      lastCodeSnapshot: null,
      nodeType: tn.type || 'task', // task, session, idea
      urgent: tn.urgent || false,
      relevance: tn.relevance ?? 0.5,
      detail: tn.detail || '',
      waiting: tn.waiting || false,
      awaitingChoice: tn.awaitingChoice || false,
      sourceId: tn.sourceId,
      done: tn.status === 'done',
    };

    // Create a TreeNode
    const children = thoughtNodes
      .filter((n) => n.parentId === tn.id)
      .map((n) => n.id);

    nodes[tn.id] = {
      id: tn.id,
      taskId: tn.id,
      parentId: tn.parentId || null,
      children,
      startedAt: tn.lastActiveAt || Date.now(),
      endedAt: tn.status === 'done' ? tn.lastActiveAt : null,
      state: tn.id === activeNodeId ? 'active'
        : (Date.now() - (tn.lastActiveAt || 0) > 30 * 60 * 1000) ? 'stale'
        : 'recent',
    };
  }

  // Get tree base color
  const trees: Tree[] = state.trees || [];
  const activeTreeId = state.activeTreeId;
  const activeTree = trees.find((t) => t.id === activeTreeId) || trees[0];
  const baseColor = activeTree?.baseColor || '#b44dff';

  // Choose the root to render. There can be more than one parentless node
  // (e.g. a transient duplicate tree); prefer the root of the active tree,
  // otherwise the root whose subtree contains the most nodes — never just
  // the last one in the array, which may be an empty duplicate.
  const roots = thoughtNodes.filter((n) => !n.parentId);
  if (roots.length > 0) {
    const subtreeSize = (id: string): number =>
      1 + thoughtNodes
        .filter((n) => n.parentId === id)
        .reduce((sum, c) => sum + subtreeSize(c.id), 0);
    const inActiveTree = roots.find((n) => n.treeId === activeTreeId);
    rootNodeId = (inActiveTree
      ? inActiveTree
      : [...roots].sort((a, b) => subtreeSize(b.id) - subtreeSize(a.id))[0]
    ).id;
  }

  return { tasks, nodes, rootNodeId, activeNodeId, priority, baseColor };
}
