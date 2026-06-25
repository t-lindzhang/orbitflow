import React, { useState, useEffect } from 'react';
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
  relevance: number;
  detail: string;
  waiting: boolean;
}

function NodeShape({ cx, cy, nodeType, state, isActive, stroke, fill }: {
  cx: number; cy: number; nodeType: NodeType; state: string; isActive: boolean;
  stroke: string; fill: string;
}) {
  const r = isActive ? 10 : 7;
  const style = {
    fill: isActive ? fill : '#1a1a2e',
    stroke,
    strokeWidth: 2.5,
    filter: `drop-shadow(0 0 ${isActive ? 6 : 4}px ${stroke}80)`,
  };

  switch (nodeType) {
    case 'session':
      const size = r * 1.6;
      return <rect style={style}
        x={cx - size / 2} y={cy - size / 2}
        width={size} height={size}
        rx={2} ry={2}
      />;
    case 'idea':
      const h = r * 1.8;
      const w = r * 1.6;
      const points = `${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`;
      return <polygon style={style} points={points} />;
    case 'task':
    default:
      return <circle style={style} cx={cx} cy={cy} r={r} />;
  }
}

export function CompactTree({ state, onSelectNode }: CompactTreeProps) {
  const [hovered, setHovered] = useState<LayoutNode | null>(null);
  const [pinned, setPinned] = useState<LayoutNode | null>(null);
  const baseColor = state.baseColor || '#b44dff';
  const complementary = getComplementaryColor(baseColor);

  // A clicked node pins its preview; hovering only previews when nothing is
  // pinned (mirrors the editor's sticky card taking precedence over hover).
  const preview = pinned ?? hovered;

  // Dismiss the pinned preview when clicking outside it and outside any node.
  useEffect(() => {
    if (!pinned) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || (!target.closest('.mini-preview') && !target.closest('.mini-node'))) {
        setPinned(null);
      }
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [pinned]);

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
        {nodes.map(n => {
          const isActive = n.state === 'active';
          const needsAttention = n.waiting && !isActive;
          const relevance = n.relevance ?? 0.5;
          const saturation = isActive ? 1 : 0.3 + relevance * 0.7;
          const nodeColor = isActive ? complementary : baseColor;
          const nodeFill = isActive ? complementary : '#1a1a2e';
          return (
            <g
              key={n.id}
              className={`mini-node ${needsAttention ? 'needs-attention' : ''}`}
              onClick={() => { onSelectNode(n.id); setPinned(n); }}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: 'pointer', filter: !isActive ? `saturate(${saturation})` : undefined }}
            >
              <NodeShape
                cx={n.x} cy={n.y}
                nodeType={n.nodeType}
                state={n.state}
                isActive={isActive}
                stroke={nodeColor}
                fill={nodeFill}
              />
            </g>
          );
        })}
      </svg>

      {/* Hover / pinned preview popup */}
      {preview && (
        <div className="mini-preview">
          <div className="mini-preview-header">
            <span className="mini-preview-name">{preview.name}</span>
            <span className={`mini-preview-badge ${preview.state}`}>
              {preview.state === 'active' ? 'Active' : preview.state === 'stale' ? 'Stale' : 'Recent'}
            </span>
          </div>
          <div className="mini-preview-time">🕐 {getTimeAgo(preview.startedAt)}</div>
          {preview.detail && (
            <div className="mini-preview-desc">{preview.detail}</div>
          )}
          <div className="mini-preview-files">
            {preview.files.slice(0, 2).map((f, i) => (
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
      relevance: task?.relevance ?? 0.5,
      detail: task?.detail || '',
      waiting: task?.waiting || false,
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

function getComplementaryColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  h = (h + 0.5) % 1;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rr = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const gg = Math.round(hue2rgb(p, q, h) * 255);
  const bb = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  return `#${rr.toString(16).padStart(2,'0')}${gg.toString(16).padStart(2,'0')}${bb.toString(16).padStart(2,'0')}`;
}
