import React, { useState, useMemo, useRef, useEffect } from 'react';
import { FocusTreeState, TreeNode, Task, NodeType } from '../types';
import { zoom, zoomIdentity } from 'd3-zoom';
import { select } from 'd3-selection';

interface WorkingTreeProps {
  state: FocusTreeState;
  onSelectNode: (nodeId: string) => void;
  onResumeNode: (nodeId: string) => void;
  onPruneNode: (nodeId: string) => void;
}

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  node: TreeNode;
  task: Task;
}

const DEPTH_THRESHOLD = 3;

export function WorkingTree({ state, onSelectNode, onResumeNode, onPruneNode }: WorkingTreeProps) {
  const [hoveredNode, setHoveredNode] = useState<PositionedNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<PositionedNode | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomBehavior = useRef<any>(null);

  const positioned = useMemo(() => {
    if (!state.rootNodeId) return [];
    return layoutTree(state, state.rootNodeId);
  }, [state]);

  // Set up D3 zoom/pan
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;

    const svg = select(svgRef.current);
    const g = select(gRef.current);

    zoomBehavior.current = zoom()
      .scaleExtent([0.3, 3])
      .on('zoom', (event: any) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoomBehavior.current as any);

    // Fit to view on first render
    if (positioned.length > 0) {
      const vb = getViewBox(positioned);
      const [x, y, w, h] = vb.split(' ').map(Number);
      const svgEl = svgRef.current;
      const { width: svgW, height: svgH } = svgEl.getBoundingClientRect();
      const scale = Math.min(svgW / w, svgH / h) * 0.85;
      const tx = (svgW - w * scale) / 2 - x * scale;
      const ty = (svgH - h * scale) / 2 - y * scale;
      svg.call(zoomBehavior.current.transform as any, zoomIdentity.translate(tx, ty).scale(scale));
    }
  }, [positioned.length]);

  const handleZoomIn = () => {
    if (!svgRef.current || !zoomBehavior.current) return;
    select(svgRef.current).transition().duration(200)
      .call(zoomBehavior.current.scaleBy as any, 1.3);
  };
  const handleZoomOut = () => {
    if (!svgRef.current || !zoomBehavior.current) return;
    select(svgRef.current).transition().duration(200)
      .call(zoomBehavior.current.scaleBy as any, 0.7);
  };
  const handleZoomReset = () => {
    if (!svgRef.current || !zoomBehavior.current || positioned.length === 0) return;
    const svg = select(svgRef.current);
    const svgEl = svgRef.current;
    const { width: svgW, height: svgH } = svgEl.getBoundingClientRect();

    // Calculate bounds of all nodes
    const xs = positioned.map(p => p.x);
    const ys = positioned.map(p => p.y);
    const minX = Math.min(...xs) - 60;
    const maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 50;
    const maxY = Math.max(...ys) + 80;
    const treeW = maxX - minX;
    const treeH = maxY - minY;

    // Scale to fit, then center
    const scale = Math.min(svgW / treeW, svgH / treeH) * 0.85;
    const tx = (svgW - treeW * scale) / 2 - minX * scale;
    const ty = (svgH - treeH * scale) / 2 - minY * scale;

    svg.transition().duration(400)
      .call(zoomBehavior.current.transform as any, zoomIdentity.translate(tx, ty).scale(scale));
  };

  // Calculate active node depth for nudge
  const activeDepth = useMemo(() => {
    if (!state.activeNodeId) return 0;
    let depth = 0;
    let current = state.nodes[state.activeNodeId];
    while (current?.parentId) {
      depth++;
      current = state.nodes[current.parentId];
    }
    return depth;
  }, [state]);

  const rootTask = useMemo(() => {
    if (!state.rootNodeId) return null;
    const rootNode = state.nodes[state.rootNodeId];
    return rootNode ? state.tasks[rootNode.taskId] : null;
  }, [state]);

  if (!state.rootNodeId) {
    return (
      <div className="working-tree-empty">
        <p>Start working to build your focus tree...</p>
        <p className="hint">The tree grows as you switch between tasks.</p>
      </div>
    );
  }

  const showNudge = activeDepth >= DEPTH_THRESHOLD && !nudgeDismissed;

  return (
    <div className="working-tree-container">
      {/* Main SVG Tree — D3 zoom/pan enabled */}
      <svg className="working-tree-svg" ref={svgRef}>
        <g ref={gRef}>
        {/* Edges with prune buttons */}
        {positioned.map(pn => {
          if (!pn.node.parentId) return null;
          const parent = positioned.find(p => p.id === pn.node.parentId);
          if (!parent) return null;
          const parentR = parent.node.state === 'active' ? 22 : parent.node.parentId ? 16 : 22;
          const labelOffset = parentR + 26;
          // Midpoint of the edge for the prune button
          const midX = (parent.x + pn.x) / 2;
          const midY = (parent.y + labelOffset + pn.y - 22) / 2;
          return (
            <g key={`edge-${pn.id}`}>
              <path
                className="tree-edge"
                d={`M${parent.x},${parent.y + labelOffset} C${parent.x},${parent.y + labelOffset + 30} ${pn.x},${pn.y - 40} ${pn.x},${pn.y - 22}`}
              />
              <g className="prune-btn" onClick={(e) => { e.stopPropagation(); onPruneNode(pn.id); }}>
                <circle cx={midX} cy={midY} r={8} className="prune-bg" />
                <text x={midX} y={midY + 4} className="prune-icon">✂</text>
              </g>
            </g>
          );
        })}

        {/* Nodes */}
        {positioned.map(pn => {
          const r = pn.node.state === 'active' ? 22 : pn.node.parentId ? 16 : 22;
          const isUrgent = pn.task.urgent;
          const relevance = pn.task.relevance ?? 0.5;
          const isActive = pn.node.state === 'active';
          const saturation = isActive ? 1 : 0.3 + relevance * 0.7;
          const baseColor = state.baseColor || '#b44dff';
          const complementary = getComplementaryColor(baseColor);
          const nodeStroke = isActive ? complementary : baseColor;
          const nodeFill = isActive ? complementary : '#1a1a2e';
          return (
            <g
              key={pn.id}
              className={`tree-node ${pn.node.state} ${isUrgent ? 'urgent' : ''}`}
              style={{ filter: !isActive ? `saturate(${saturation})` : undefined }}
              onClick={() => setSelectedNode(pn)}
              onMouseEnter={() => setHoveredNode(pn)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              {isUrgent && <UrgentBorder cx={pn.x} cy={pn.y} r={r + 6} nodeType={pn.task.nodeType || 'task'} />}
              <TreeNodeShape cx={pn.x} cy={pn.y} r={r} nodeType={pn.task.nodeType || 'task'}
                stroke={nodeStroke} fill={nodeFill} isActive={isActive} />
              <text className="node-label" x={pn.x} y={pn.y + r + 10}>
                {truncate(pn.task.name, 30)}
              </text>
            </g>
          );
        })}
        </g>
      </svg>

      {/* Bottom bar: zoom controls + legend */}
      <div className="bottom-bar">
        <div className="zoom-controls">
          <button onClick={handleZoomIn} title="Zoom in">+</button>
          <button onClick={handleZoomOut} title="Zoom out">−</button>
          <button onClick={handleZoomReset} title="Reset zoom">⤢</button>
        </div>
        <div className="legend">
          <span className="legend-item"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2"/></svg> Task</span>
          <span className="legend-item"><svg width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2"/></svg> Session</span>
          <span className="legend-item"><svg width="12" height="12"><polygon points="6,1 1,11 11,11" fill="none" stroke="currentColor" strokeWidth="2"/></svg> Idea</span>
        </div>
      </div>

      {/* Minimap */}
      <div className="minimap">
        <svg viewBox={getViewBox(positioned)}>
          {positioned.map(pn => {
            if (!pn.node.parentId) return null;
            const parent = positioned.find(p => p.id === pn.node.parentId);
            if (!parent) return null;
            return (
              <line key={`mm-e-${pn.id}`} className="mm-edge"
                x1={parent.x} y1={parent.y} x2={pn.x} y2={pn.y} />
            );
          })}
          {positioned.map(pn => {
            const baseColor = state.baseColor || '#b44dff';
            const complementary = getComplementaryColor(baseColor);
            const isActive = pn.node.state === 'active';
            const color = isActive ? complementary : baseColor;
            return (
              <circle key={`mm-${pn.id}`}
                cx={pn.x} cy={pn.y} r={isActive ? 6 : 4}
                style={{ fill: isActive ? color : color, opacity: isActive ? 1 : 0.6 }}
              />
            );
          })}
        </svg>
      </div>

      {/* Nudge (side-positioned) */}
      {showNudge && (
        <div className="nudge-container">
          <div className="nudge">
            <div className="nudge-title">🟢 Deep Focus Alert</div>
            <div className="nudge-depth">
              You're <strong>{activeDepth} levels deep</strong> from<br/>
              <strong>{rootTask?.name || 'root'}</strong>
            </div>
            <button onClick={() => { onSelectNode(state.rootNodeId!); setNudgeDismissed(true); }}>
              ↩ Back to {rootTask?.name || 'root'}
            </button>
            <button className="dismiss" onClick={() => setNudgeDismissed(true)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Preview Card (on hover) */}
      {hoveredNode && !selectedNode && <PreviewCard node={hoveredNode} />}

      {/* Sticky Node Card (on click — does NOT auto-resume) */}
      {selectedNode && (
        <StickyNodeCard
          node={selectedNode}
          onResume={() => { onResumeNode(selectedNode.id); setSelectedNode(null); }}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

function TreeNodeShape({ cx, cy, r, nodeType, stroke, fill, isActive }: {
  cx: number; cy: number; r: number; nodeType: NodeType;
  stroke: string; fill: string; isActive: boolean;
}) {
  const style = {
    fill: isActive ? fill : '#1a1a2e',
    stroke,
    strokeWidth: 4,
    filter: `drop-shadow(0 0 ${isActive ? 12 : 6}px ${stroke}80)`,
  };

  switch (nodeType) {
    case 'session':
      const size = r * 1.7;
      return <rect style={style}
        x={cx - size / 2} y={cy - size / 2}
        width={size} height={size} rx={4} ry={4} />;
    case 'idea':
      const h = r * 2;
      const w = r * 1.8;
      const points = `${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`;
      return <polygon style={style} points={points} />;
    case 'task':
    default:
      return <circle style={style} cx={cx} cy={cy} r={r} />;
  }
}

function UrgentBorder({ cx, cy, r, nodeType }: {
  cx: number; cy: number; r: number; nodeType: NodeType;
}) {
  switch (nodeType) {
    case 'session':
      const size = r * 1.7;
      return <rect className="urgent-border"
        x={cx - size / 2} y={cy - size / 2}
        width={size} height={size} rx={6} ry={6} />;
    case 'idea':
      const h = r * 2;
      const w = r * 1.8;
      const points = `${cx},${cy - h / 2} ${cx - w / 2},${cy + h / 2} ${cx + w / 2},${cy + h / 2}`;
      return <polygon className="urgent-border" points={points} />;
    case 'task':
    default:
      return <circle className="urgent-border" cx={cx} cy={cy} r={r} />;
  }
}

function PreviewCard({ node }: { node: PositionedNode }) {
  const timeAgo = getTimeAgo(node.node.startedAt);
  const stateLabel = node.node.state === 'active' ? 'Active Now'
    : node.node.state === 'stale' ? 'Stale' : 'Recent';
  const typeLabel = node.task.nodeType === 'session' ? '⬜ Session'
    : node.task.nodeType === 'idea' ? '🔺 Idea' : '⭕ Task';

  return (
    <div className="preview-card">
      <div className="card-header">
        <span className="card-task-name">{node.task.name}</span>
        <span className={`card-status ${node.node.state}`}>{stateLabel}</span>
      </div>
      <div className="card-meta">
        <span className="meta-item">🕐 {timeAgo}</span>
        <span className="meta-item">{typeLabel}</span>
      </div>
      <div className="card-files">
        {node.task.files.length > 0
          ? node.task.files.slice(0, 3).map((f, i) => (
              <span key={i} className="file-tag">{getFileName(f)}</span>
            ))
          : <span className="file-tag">No files yet</span>
        }
      </div>
      <div className="card-footer">Click to resume this task</div>
    </div>
  );
}

function StickyNodeCard({ node, onResume, onClose }: {
  node: PositionedNode;
  onResume: () => void;
  onClose: () => void;
}) {
  const timeAgo = getTimeAgo(node.node.startedAt);
  const stateLabel = node.node.state === 'active' ? 'Active Now'
    : node.node.state === 'stale' ? 'Stale' : 'Recent';
  const typeLabel = node.task.nodeType === 'session' ? '⬜ Session'
    : node.task.nodeType === 'idea' ? '🔺 Idea' : '⭕ Task';

  return (
    <div className="sticky-card" onClick={(e) => e.stopPropagation()}>
      <div className="sticky-card-header">
        <span className="sticky-card-title">{node.task.name}</span>
        <button className="sticky-card-close" onClick={onClose}>×</button>
      </div>
      <div className="sticky-card-meta">
        <span>🕐 {timeAgo}</span>
        <span>{typeLabel}</span>
        <span className={`card-status ${node.node.state}`}>{stateLabel}</span>
      </div>
      <div className="sticky-card-files">
        {node.task.files.length > 0
          ? node.task.files.slice(0, 3).map((f, i) => (
              <span key={i} className="file-tag">{getFileName(f)}</span>
            ))
          : <span className="file-tag">No files yet</span>
        }
      </div>
      <div className="sticky-card-actions">
        <button className="sticky-resume-btn" onClick={onResume}>▶ Resume</button>
      </div>
    </div>
  );
}

// Layout algorithm
function layoutTree(state: FocusTreeState, rootId: string): PositionedNode[] {
  const result: PositionedNode[] = [];
  const HORIZONTAL_SPACING = 160;
  const VERTICAL_SPACING = 130;

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
  const minX = Math.min(...xs) - 60;
  const maxX = Math.max(...xs) + 60;
  const minY = Math.min(...ys) - 50;
  const maxY = Math.max(...ys) + 70;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
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

/** Compute a complementary color by rotating hue 180°. */
function getComplementaryColor(hex: string): string {
  // Parse hex to RGB
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  // RGB to HSL
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

  // Rotate hue 180°
  h = (h + 0.5) % 1;

  // HSL to RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const gg = Math.round(hue2rgb(p, q, h) * 255);
  const bb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${rr.toString(16).padStart(2, '0')}${gg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`;
}
