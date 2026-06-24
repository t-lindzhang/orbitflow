import React, { useState, useMemo } from 'react';
import { FocusTreeState, TreeNode, Task, NodeType } from '../types';

interface WorkingTreeProps {
  state: FocusTreeState;
  onSelectNode: (nodeId: string) => void;
}

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  node: TreeNode;
  task: Task;
}

export function WorkingTree({ state, onSelectNode }: WorkingTreeProps) {
  const [hoveredNode, setHoveredNode] = useState<PositionedNode | null>(null);

  const positioned = useMemo(() => {
    if (!state.rootNodeId) return [];
    return layoutTree(state, state.rootNodeId);
  }, [state]);

  if (!state.rootNodeId) {
    return (
      <div className="working-tree-empty">
        <p>Start working to build your focus tree...</p>
        <p className="hint">The tree grows as you switch between tasks.</p>
      </div>
    );
  }

  return (
    <div className="working-tree-container">
      <svg className="working-tree-svg" viewBox={getViewBox(positioned)}>
        {/* Edges */}
        {positioned.map(pn => {
          if (!pn.node.parentId) return null;
          const parent = positioned.find(p => p.id === pn.node.parentId);
          if (!parent) return null;
          return (
            <path
              key={`edge-${pn.id}`}
              className="tree-edge"
              d={`M${parent.x},${parent.y + 22} C${parent.x},${parent.y + 50} ${pn.x},${pn.y - 50} ${pn.x},${pn.y - 22}`}
            />
          );
        })}

        {/* Nodes */}
        {positioned.map(pn => {
          const r = pn.node.state === 'active' ? 22 : pn.node.parentId ? 16 : 22;
          return (
            <g
              key={pn.id}
              className={`tree-node ${pn.node.state}`}
              onClick={() => onSelectNode(pn.id)}
              onMouseEnter={() => setHoveredNode(pn)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              <TreeNodeShape cx={pn.x} cy={pn.y} r={r} nodeType={pn.task.nodeType || 'task'} />
              <text className="node-label" x={pn.x} y={pn.y + 4}>
                {truncate(pn.task.name, 8)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Preview Card */}
      {hoveredNode && (
        <PreviewCard node={hoveredNode} positioned={positioned} />
      )}
    </div>
  );
}

function TreeNodeShape({ cx, cy, r, nodeType }: {
  cx: number; cy: number; r: number; nodeType: NodeType;
}) {
  switch (nodeType) {
    case 'session':
      // Rounded square with ring styling
      const size = r * 1.7;
      return <rect
        className="node-ring"
        x={cx - size / 2} y={cy - size / 2}
        width={size} height={size}
        rx={4} ry={4}
      />;
    case 'idea':
      // Triangle with ring styling
      const h = r * 2;
      const w = r * 1.8;
      const points = `${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`;
      return <polygon className="node-ring" points={points} />;
    case 'task':
    default:
      // Circle (the original ring node)
      return <circle className="node-ring" cx={cx} cy={cy} r={r} />;
  }
}

function PreviewCard({ node, positioned }: { node: PositionedNode; positioned: PositionedNode[] }) {
  const timeAgo = getTimeAgo(node.node.startedAt);
  const stateLabel = node.node.state === 'active' ? 'Active Now'
    : node.node.state === 'stale' ? 'Stale' : 'Recent';

  return (
    <div className="preview-card" style={getCardPosition(node, positioned)}>
      <div className="card-header">
        <span className="card-task-name">{node.task.name}</span>
        <span className={`card-status ${node.node.state}`}>{stateLabel}</span>
      </div>
      <div className="card-meta">
        <span>🕐 {timeAgo}</span>
      </div>
      <div className="card-files">
        {node.task.files.slice(0, 3).map((f, i) => (
          <span key={i} className="file-tag">{getFileName(f)}</span>
        ))}
      </div>
      <div className="card-footer">Click to resume</div>
    </div>
  );
}

// Simple tree layout algorithm
function layoutTree(state: FocusTreeState, rootId: string): PositionedNode[] {
  const result: PositionedNode[] = [];
  const HORIZONTAL_SPACING = 90;
  const VERTICAL_SPACING = 90;

  function getSubtreeWidth(nodeId: string): number {
    const node = state.nodes[nodeId];
    if (!node || node.children.length === 0) return 1;
    return node.children.reduce((sum, childId) => sum + getSubtreeWidth(childId), 0);
  }

  function position(nodeId: string, depth: number, leftOffset: number): void {
    const node = state.nodes[nodeId];
    if (!node) return;
    const task = state.tasks[node.taskId];
    if (!task) return;

    const subtreeWidth = getSubtreeWidth(nodeId);
    const x = (leftOffset + subtreeWidth / 2) * HORIZONTAL_SPACING;
    const y = depth * VERTICAL_SPACING + 40;

    result.push({ id: nodeId, x, y, node, task });

    let childOffset = leftOffset;
    for (const childId of node.children) {
      const childWidth = getSubtreeWidth(childId);
      position(childId, depth + 1, childOffset);
      childOffset += childWidth;
    }
  }

  position(rootId, 0, 0);
  return result;
}

function getViewBox(positioned: PositionedNode[]): string {
  if (positioned.length === 0) return '0 0 400 400';
  const xs = positioned.map(p => p.x);
  const ys = positioned.map(p => p.y);
  const minX = Math.min(...xs) - 50;
  const maxX = Math.max(...xs) + 50;
  const minY = Math.min(...ys) - 50;
  const maxY = Math.max(...ys) + 50;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

function getCardPosition(node: PositionedNode, _positioned: PositionedNode[]) {
  // Position to the right of the node (CSS will handle overflow)
  return {
    left: '60%',
    top: '20%',
  };
}

function getTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}
