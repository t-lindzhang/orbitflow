import React, { useState } from 'react';
import { FocusTreeState, TreeNode, NodeType } from '../types';

interface CompactTreeProps {
  state: FocusTreeState;
  onSelectNode: (nodeId: string) => void;
}

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  state: string;
  name: string;
  parentId: string | null;
  files: string[];
  startedAt: number;
  nodeType: NodeType;
}

function NodeShape({ cx, cy, nodeType, state, isActive }: {
  cx: number; cy: number; nodeType: NodeType; state: string; isActive: boolean;
}) {
  const r = isActive ? 10 : 7;
  const className = `mini-node ${state}`;

  switch (nodeType) {
    case 'session':
      // Square (rounded rect)
      const size = r * 1.6;
      return <rect
        className={className}
        x={cx - size / 2} y={cy - size / 2}
        width={size} height={size}
        rx={2} ry={2}
      />;
    case 'idea':
      // Triangle
      const h = r * 1.8;
      const w = r * 1.6;
      const points = `${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`;
      return <polygon className={className} points={points} />;
    case 'task':
    default:
      // Circle (default)
      return <circle className={className} cx={cx} cy={cy} r={r} />;
  }
}

export function CompactTree({ state, onSelectNode }: CompactTreeProps) {
  const [hovered, setHovered] = useState<LayoutNode | null>(null);

  if (!state.rootNodeId) {
    return <div className="empty-state">Start working to build your focus tree...</div>;
  }

  const nodes = layoutMiniTree(state);

  if (nodes.length === 0) {
    return <div className="empty-state">No nodes yet</div>;
  }

  const maxX = Math.max(...nodes.map(n => n.x));
  const maxY = Math.max(...nodes.map(n => n.y));
  const viewWidth = maxX + 40;
  const viewHeight = maxY + 40;

  return (
    <div className="compact-tree-svg-container">
      <svg
        className="compact-tree-svg"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        style={{ width: '100%', height: `${Math.min(viewHeight, 300)}px` }}
      >
        {/* Edges */}
        {nodes.map(n => {
          if (!n.parentId) return null;
          const parent = nodes.find(p => p.id === n.parentId);
          if (!parent) return null;
          return (
            <line
              key={`e-${n.id}`}
              className="mini-edge"
              x1={parent.x} y1={parent.y}
              x2={n.x} y2={n.y}
            />
          );
        })}

        {/* Nodes — shape based on type */}
        {nodes.map(n => (
          <g
            key={n.id}
            onClick={() => onSelectNode(n.id)}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'pointer' }}
          >
            <NodeShape
              cx={n.x} cy={n.y}
              nodeType={n.nodeType}
              state={n.state}
              isActive={n.state === 'active'}
            />
          </g>
        ))}
      </svg>

      {/* Hover preview popup */}
      {hovered && (
        <div className="mini-preview">
          <div className="mini-preview-header">
            <span className="mini-preview-name">{hovered.name}</span>
            <span className={`mini-preview-badge ${hovered.state}`}>
              {hovered.state === 'active' ? 'Active' : hovered.state === 'stale' ? 'Stale' : 'Recent'}
            </span>
          </div>
          <div className="mini-preview-time">🕐 {getTimeAgo(hovered.startedAt)}</div>
          <div className="mini-preview-files">
            {hovered.files.slice(0, 2).map((f, i) => (
              <span key={i} className="mini-file-tag">{getFileName(f)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function layoutMiniTree(state: FocusTreeState): LayoutNode[] {
  const result: LayoutNode[] = [];
  if (!state.rootNodeId) return result;

  const H_SPACE = 50;
  const V_SPACE = 45;

  function getWidth(nodeId: string): number {
    const node = state.nodes[nodeId];
    if (!node || node.children.length === 0) return 1;
    return node.children.reduce((sum, cid) => sum + getWidth(cid), 0);
  }

  function place(nodeId: string, depth: number, left: number): void {
    const node = state.nodes[nodeId];
    if (!node) return;
    const task = state.tasks[node.taskId];
    const w = getWidth(nodeId);
    const x = (left + w / 2) * H_SPACE;
    const y = depth * V_SPACE + 20;

    result.push({
      id: nodeId, x, y,
      state: node.state,
      name: task?.name || '?',
      parentId: node.parentId,
      files: task?.files || [],
      startedAt: node.startedAt,
      nodeType: task?.nodeType || 'task',
    });

    let offset = left;
    for (const cid of node.children) {
      const cw = getWidth(cid);
      place(cid, depth + 1, offset);
      offset += cw;
    }
  }

  place(state.rootNodeId, 0, 0);
  return result;
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
