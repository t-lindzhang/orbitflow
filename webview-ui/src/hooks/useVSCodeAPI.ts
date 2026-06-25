import { useState, useEffect, useCallback } from 'react';
import { FocusTreeState } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): FocusTreeState | undefined;
  setState(state: FocusTreeState): void;
};

const vscode = acquireVsCodeApi();

export function useVSCodeAPI() {
  // Restore from VS Code's webview state persistence
  const [state, setState] = useState<FocusTreeState | null>(
    vscode.getState() || null
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      // Handle both OrbitFlow format and our format
      if (message.type === 'stateUpdate' || message.type === 'state') {
        const newState = message.state;
        const priority = message.priority || [];
        // Convert OrbitFlow state to our format if needed
        const converted = convertState(newState, priority);
        setState(converted);
        vscode.setState(converted);
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
    } else if (command === 'delete') {
      vscode.postMessage({ type: 'delete', nodeId: data?.nodeId });
    } else if (command === 'pruneSubtree') {
      vscode.postMessage({ type: 'pruneSubtree', nodeId: data?.nodeId });
    } else if (command === 'toggleDone') {
      vscode.postMessage({ type: 'toggleDone', nodeId: data?.nodeId });
    } else {
      vscode.postMessage({ type: command, ...data });
    }
  }, []);

  return { state, sendMessage };
}

// Convert OrbitFlow state format to our FocusTreeState format
function convertState(orbitState: any, priority: any[] = []): FocusTreeState {
  // If it's already our format, return as-is
  if (orbitState.tasks && orbitState.nodes && !Array.isArray(orbitState.nodes)) {
    return { ...orbitState, priority };
  }

  // Convert OrbitFlow format (arrays) to our format (records)
  const tasks: Record<string, any> = {};
  const nodes: Record<string, any> = {};
  let rootNodeId: string | null = null;
  const activeNodeId: string | null = orbitState.activeNodeId || null;

  // OrbitFlow uses arrays of ThoughtNodes
  const thoughtNodes: any[] = orbitState.nodes || [];

  for (const tn of thoughtNodes) {
    // Create a Task from the ThoughtNode
    tasks[tn.id] = {
      id: tn.id,
      name: tn.title || '?',
      files: tn.snapshot?.files?.map((f: any) => f.path) || [],
      createdAt: tn.lastActiveAt || Date.now(),
      totalTimeSpent: 0,
      lastCodeSnapshot: null,
      nodeType: tn.type || 'task', // task, session, idea
      urgent: tn.urgent || false,
      relevance: tn.relevance ?? 0.5,
    };

    // Create a TreeNode
    const children = thoughtNodes
      .filter(n => n.parentId === tn.id)
      .map(n => n.id);

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
  const trees: any[] = orbitState.trees || [];
  const activeTreeId = orbitState.activeTreeId;
  const activeTree = trees.find((t: any) => t.id === activeTreeId) || trees[0];
  const baseColor = activeTree?.baseColor || '#b44dff';

  // Choose the root to render. There can be more than one parentless node
  // (e.g. a transient duplicate tree); prefer the root of the active tree,
  // otherwise the root whose subtree contains the most nodes — never just
  // the last one in the array, which may be an empty duplicate.
  const roots = thoughtNodes.filter(n => !n.parentId);
  if (roots.length > 0) {
    const subtreeSize = (id: string): number =>
      1 + thoughtNodes
        .filter(n => n.parentId === id)
        .reduce((sum, c) => sum + subtreeSize(c.id), 0);
    const inActiveTree = roots.find(n => n.treeId === activeTreeId);
    rootNodeId = (inActiveTree
      ? inActiveTree
      : [...roots].sort((a, b) => subtreeSize(b.id) - subtreeSize(a.id))[0]
    ).id;
  }

  return { tasks, nodes, rootNodeId, activeNodeId, priority, baseColor };
}
