import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent } from "d3-zoom";
import type { OrbitState, OutboundMessage, ThoughtNode } from "../src/types";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

interface Positioned {
  x: number;
  y: number;
}

let state: OrbitState = {
  trees: [],
  nodes: [],
  activeNodeId: null,
  activeTreeId: null,
};
let stickyNodeId: string | null = null;
let priorityIds = new Set<string>();

const svg = select<SVGSVGElement, unknown>("#graph");
const card = document.getElementById("card")!;
const empty = document.getElementById("empty")!;

// Pan & zoom: Ctrl/⌘ + wheel to zoom, drag to pan. Transform persists
// across re-renders so the view doesn't jump when nodes are added.
let currentTransform = zoomIdentity;
let userInteracted = false;
let lastBounds: { minX: number; minY: number; maxX: number; maxY: number } | null =
  null;
const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<
  SVGSVGElement,
  unknown
>()
  .scaleExtent([0.2, 3])
  .filter((event: Event) => {
    if (event.type === "wheel") {
      return (event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey;
    }
    // Allow drag-to-pan with the primary button; ignore right-click.
    return !(event as MouseEvent).button;
  })
  .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
    // A real user gesture stops automatic fit-to-screen.
    if (event.sourceEvent) {
      userInteracted = true;
    }
    currentTransform = event.transform;
    svg.select<SVGGElement>("g.viewport").attr(
      "transform",
      currentTransform.toString()
    );
  });

svg.call(zoomBehavior);

/** Frame the whole tree within the viewport. */
function fitToView(b: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): void {
  const sw = svg.node()!.clientWidth || 400;
  const sh = svg.node()!.clientHeight || 400;
  const padX = 60;
  const padY = 60;
  const bw = Math.max(1, b.maxX - b.minX + padX * 2);
  const bh = Math.max(1, b.maxY - b.minY + padY * 2);
  let scale = Math.min(sw / bw, sh / bh);
  scale = Math.max(0.2, Math.min(2, scale));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const t = zoomIdentity
    .translate(sw / 2 - scale * cx, sh / 2 - scale * cy)
    .scale(scale);
  zoomBehavior.transform(svg, t);
}

function zoomBy(factor: number): void {
  zoomBehavior.scaleBy(svg, factor);
}
function resetZoom(): void {
  userInteracted = false;
  if (lastBounds) {
    fitToView(lastBounds);
  } else {
    zoomBehavior.transform(svg, zoomIdentity);
  }
}

document
  .getElementById("btn-revert")!
  .addEventListener("click", () => vscode.postMessage({ type: "revert" }));
document
  .getElementById("btn-generate")!
  .addEventListener("click", () =>
    vscode.postMessage({ type: "generateTrees" })
  );
document
  .getElementById("btn-open")
  ?.addEventListener("click", () => vscode.postMessage({ type: "openGraph" }));
document
  .getElementById("btn-reorganize")!
  .addEventListener("click", () => vscode.postMessage({ type: "reorganize" }));
document
  .getElementById("btn-clear")!
  .addEventListener("click", () => vscode.postMessage({ type: "clearAll" }));
document
  .getElementById("btn-zoom-in")!
  .addEventListener("click", () => zoomBy(1.3));
document
  .getElementById("btn-zoom-out")!
  .addEventListener("click", () => zoomBy(1 / 1.3));
document
  .getElementById("btn-zoom-reset")!
  .addEventListener("click", () => resetZoom());

window.addEventListener("message", (e: MessageEvent<OutboundMessage>) => {
  if (e.data.type === "state") {
    state = e.data.state;
    priorityIds = new Set((e.data.priority ?? []).map((p) => p.id));
    render();
  }
});

window.addEventListener("resize", () => render());

function treeColor(treeId: string): string {
  return state.trees.find((t) => t.id === treeId)?.baseColor ?? "#888";
}

/**
 * Node fill: base tree color, hue-shifted by horizontal position (left/right
 * branches drift on the spectrum), then blended toward gray by relevance.
 */
function nodeFillRgb(
  hex: string,
  relevance: number,
  xNorm: number
): { r: number; g: number; b: number } {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.h = (hsl.h + xNorm * HUE_SHIFT + 360) % 360;
  const shifted = hslToRgb(hsl);
  const gray = 128;
  const t = Math.max(0, Math.min(1, relevance));
  const mix = (v: number) => Math.round(gray + (v - gray) * t);
  return { r: mix(shifted.r), g: mix(shifted.g), b: mix(shifted.b) };
}

function rgbCss({ r, g, b }: { r: number; g: number; b: number }): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/** De-saturated blend of two node colors, used for the edge between them. */
function edgeColor(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): string {
  const mid = {
    r: (a.r + b.r) / 2,
    g: (a.g + b.g) / 2,
    b: (a.b + b.b) / 2,
  };
  const lum = 0.3 * mid.r + 0.59 * mid.g + 0.11 * mid.b;
  const d = 0.3; // pull 30% toward gray to de-saturate
  return rgbCss({
    r: Math.round(mid.r + (lum - mid.r) * d),
    g: Math.round(mid.g + (lum - mid.g) * d),
    b: Math.round(mid.b + (lum - mid.b) * d),
  });
}

const HUE_SHIFT = 28; // max degrees a branch shifts left/right of base hue

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): {
  h: number;
  s: number;
  l: number;
} {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): {
  r: number;
  g: number;
  b: number;
} {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    [r1, g1, b1] = [c, x, 0];
  } else if (h < 120) {
    [r1, g1, b1] = [x, c, 0];
  } else if (h < 180) {
    [r1, g1, b1] = [0, c, x];
  } else if (h < 240) {
    [r1, g1, b1] = [0, x, c];
  } else if (h < 300) {
    [r1, g1, b1] = [x, 0, c];
  } else {
    [r1, g1, b1] = [c, 0, x];
  }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

const LEVEL_HEIGHT = 95;
const LEAF_GAP = 180;
const MARGIN_X = 90;
const MARGIN_Y = 60;

/**
 * Compute a static top-down tree layout: roots on top, children below.
 * Leaves are spread evenly; parents are centered over their children.
 */
function computeLayout(nodes: ThoughtNode[]): Map<string, Positioned> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, ThoughtNode[]>();
  for (const n of nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : "__root__";
    (children.get(key) ?? children.set(key, []).get(key)!).push(n);
  }

  const pos = new Map<string, Positioned>();
  let cursor = 0;

  const place = (node: ThoughtNode, depth: number): number => {
    const kids = children.get(node.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = cursor * LEAF_GAP;
      cursor++;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(node.id, { x: x + MARGIN_X, y: depth * LEVEL_HEIGHT + MARGIN_Y });
    return x;
  };

  for (const root of children.get("__root__") ?? []) {
    place(root, 0);
    cursor++; // gap between separate trees
  }

  return pos;
}

/** Depth of each node: 0 = root, higher = deeper / more specific. */
function computeDepths(nodes: ThoughtNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths = new Map<string, number>();
  for (const n of nodes) {
    let depth = 0;
    let cur: ThoughtNode | undefined = n;
    const guard = new Set<string>();
    while (cur && cur.parentId && byId.has(cur.parentId)) {
      if (guard.has(cur.id)) {
        break;
      }
      guard.add(cur.id);
      depth++;
      cur = byId.get(cur.parentId);
    }
    depths.set(n.id, depth);
  }
  return depths;
}

let depths = new Map<string, number>();

function render(): void {
  empty.classList.toggle("hidden", state.nodes.length > 0);

  const nodes = state.nodes;
  const pos = computeLayout(nodes);
  depths = computeDepths(nodes);

  // Normalize relevance across the observed min/max so size & color contrast
  // is obvious even when raw relevance values sit in a narrow band.
  const rels = nodes.map((n) => n.relevance);
  const minRel = rels.length ? Math.min(...rels) : 0;
  const maxRel = rels.length ? Math.max(...rels) : 1;
  const norm = (r: number): number =>
    maxRel > minRel ? (r - minRel) / (maxRel - minRel) : 1;

  // Size the SVG to fit the laid-out content so it scrolls instead of jitters.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) {
    minX = 0;
  }
  if (!isFinite(minY)) {
    minY = 0;
  }
  // Normalize horizontal position to [-1, 1] for a left/right hue shift.
  const midX = (minX + maxX) / 2;
  const spanX = (maxX - minX) / 2;
  const xNorm = (x: number): number =>
    spanX > 0 ? Math.max(-1, Math.min(1, (x - midX) / spanX)) : 0;

  // The SVG fills the canvas; navigation is handled by pan/zoom.
  svg.selectAll("*").remove();
  const viewport = svg
    .append("g")
    .attr("class", "viewport")
    .attr("transform", currentTransform.toString());

  // Precompute each node's fill so edges can blend their endpoints' colors.
  const fillById = new Map<string, { r: number; g: number; b: number }>();
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) {
      fillById.set(
        n.id,
        nodeFillRgb(treeColor(n.treeId), norm(n.relevance), xNorm(p.x))
      );
    }
  }

  const links = nodes
    .filter((n) => n.parentId && pos.has(n.parentId) && pos.has(n.id))
    .map((n) => ({
      from: pos.get(n.parentId!)!,
      to: pos.get(n.id)!,
      child: n.id,
      color: edgeColor(
        fillById.get(n.parentId!) ?? { r: 136, g: 136, b: 136 },
        fillById.get(n.id) ?? { r: 136, g: 136, b: 136 }
      ),
    }));

  type LinkDatum = (typeof links)[number];
  const pathOf = (d: LinkDatum): string => {
    const midY = (d.from.y + d.to.y) / 2;
    return `M${d.from.x},${d.from.y} C${d.from.x},${midY} ${d.to.x},${midY} ${d.to.x},${d.to.y}`;
  };

  const edgeSel = viewport
    .append("g")
    .attr("class", "links")
    .selectAll<SVGGElement, LinkDatum>("g.edge")
    .data(links, (d) => d.child)
    .join("g")
    .attr("class", "edge");

  // Visible edge.
  edgeSel
    .append("path")
    .attr("class", "link")
    .attr("stroke", (d) => d.color)
    .attr("d", pathOf);

  // Wide transparent hit area so hovering near the edge is easy.
  edgeSel
    .append("path")
    .attr("class", "edge-hit")
    .attr("d", pathOf);

  // Prune button at the edge midpoint — trims everything under it.
  const prune = edgeSel
    .append("g")
    .attr("class", "prune-btn")
    .attr(
      "transform",
      (d) => `translate(${(d.from.x + d.to.x) / 2}, ${(d.from.y + d.to.y) / 2})`
    );
  prune.append("circle").attr("r", 9);
  prune
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .text("−");

  edgeSel
    .on("mouseenter", function () {
      select(this).classed("hover", true);
    })
    .on("mouseleave", function () {
      select(this).classed("hover", false);
    });
  prune.on("click", (event: MouseEvent, d) => {
    event.stopPropagation();
    vscode.postMessage({ type: "pruneSubtree", nodeId: d.child });
  });

  const nodeSel = viewport
    .append("g")
    .attr("class", "nodes")
    .selectAll<SVGGElement, ThoughtNode>("g")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", "node")
    .attr("transform", (d) => {
      const p = pos.get(d.id)!;
      return `translate(${p.x}, ${p.y})`;
    })
    .style("cursor", "pointer");

  nodeSel.each(function (d) {
    const g = select(this);
    const t = norm(d.relevance);
    const fill = rgbCss(fillById.get(d.id) ?? { r: 136, g: 136, b: 136 });
    // Scale node size across the normalized range for an obvious difference.
    const r = Math.round(8 + t * 16);
    if (d.type === "session") {
      g.append("rect")
        .attr("x", -r)
        .attr("y", -r)
        .attr("width", r * 2)
        .attr("height", r * 2)
        .attr("rx", 2)
        .attr("fill", fill);
    } else if (d.type === "idea") {
      g.append("polygon")
        .attr("points", `0,${-r - 2} ${r + 1},${r} ${-r - 1},${r}`)
        .attr("fill", fill);
    } else {
      g.append("circle").attr("r", r).attr("fill", fill);
    }

    if (d.id === state.activeNodeId) {
      g.classed("active", true);
    }

    if (priorityIds.has(d.id)) {
      g.classed("priority", true);
      g.append("circle")
        .attr("r", r + 4)
        .attr("class", "priority-ring");
    }

    if (d.urgent) {
      g.append("circle")
        .attr("r", r + 5)
        .attr("class", "urgent-ring");
    }

    if (d.status === "done") {
      g.classed("done", true);
      const check = g
        .append("g")
        .attr("class", "check")
        .attr("transform", `translate(${r - 1}, ${-r + 1})`);
      check.append("circle").attr("r", 6);
      check
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.34em")
        .text("✓");
    }

    // Depth number: 0 = root, higher = deeper / more specific.
    g.append("text")
      .attr("class", "depth-num")
      .attr("x", 0)
      .attr("y", 0)
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .text(depths.get(d.id) ?? 0);

    // Wrapped title: up to 2 centered lines, ellipsis if longer.
    const lines = wrapLabel(d.title, 16, 2);
    const label = g
      .append("text")
      .attr("class", "label")
      .attr("x", 0)
      .attr("y", r + 14)
      .attr("text-anchor", "middle");
    lines.forEach((ln, i) => {
      label
        .append("tspan")
        .attr("x", 0)
        .attr("dy", i === 0 ? 0 : 12)
        .text(ln);
    });

    g.append("text")
      .attr("class", "sublabel")
      .attr("x", 0)
      .attr("y", r + 16 + lines.length * 12)
      .attr("text-anchor", "middle")
      .text(timeAgo(d.lastActiveAt));
  });

  nodeSel
    .on("mouseenter", (_e, d) => {
      if (!stickyNodeId) {
        showCard(d, false);
      }
    })
    .on("mouseleave", () => {
      if (!stickyNodeId) {
        hideCard();
      }
    })
    .on("click", (_e, d) => {
      stickyNodeId = d.id;
      vscode.postMessage({ type: "select", nodeId: d.id });
      showCard(d, true);
    });

  // Frame the whole tree by default, until the user pans/zooms themselves.
  lastBounds = { minX, minY, maxX, maxY };
  if (!userInteracted && nodes.length > 0) {
    fitToView(lastBounds);
  }
}

function showCard(node: ThoughtNode, sticky: boolean): void {
  const files = node.snapshot.files
    .map((f) => `<li>${escapeHtml(shortPath(f.path))}${
      f.line !== undefined ? `:${f.line + 1}` : ""
    }</li>`)
    .join("");

  card.innerHTML = `
    <div class="card-head">
      <span class="card-title">${escapeHtml(node.title)}</span>
      ${sticky ? '<span class="card-close" id="card-close">×</span>' : ""}
    </div>
    <div class="card-meta">${node.type} · ${
      node.status === "done" ? "done" : "open"
    } · ${timeAgo(node.lastActiveAt)}</div>
    <div class="card-detail">${escapeHtml(node.detail)}</div>
    ${files ? `<ul class="card-files">${files}</ul>` : ""}
    ${
      sticky
        ? `<div class="card-actions">
            <button id="card-done">${
              node.status === "done" ? "Reopen" : "Mark done"
            }</button>
            <button id="card-resume">Resume</button>
            <button id="card-delete" class="danger">Delete</button>
          </div>`
        : ""
    }
  `;
  card.classList.remove("hidden");

  if (sticky) {
    document
      .getElementById("card-done")
      ?.addEventListener("click", () =>
        vscode.postMessage({ type: "toggleDone", nodeId: node.id })
      );
    document
      .getElementById("card-resume")
      ?.addEventListener("click", () =>
        vscode.postMessage({ type: "resume", nodeId: node.id })
      );
    document.getElementById("card-delete")?.addEventListener("click", () => {
      vscode.postMessage({ type: "delete", nodeId: node.id });
      stickyNodeId = null;
      hideCard();
    });
    document.getElementById("card-close")?.addEventListener("click", () => {
      stickyNodeId = null;
      hideCard();
    });
  }
}

function hideCard(): void {
  card.classList.add("hidden");
}

function shortPath(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts.slice(-2).join("/");
}

/** Wrap a title into up to `maxLines` lines of ~`maxChars`, ellipsizing overflow. */
function wrapLabel(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        break;
      }
    } else {
      current = candidate;
    }
  }
  // Remaining words go on the last line.
  const placed = lines.join(" ").split(/\s+/).filter(Boolean).length;
  const rest = words.slice(placed).join(" ");
  if (rest) {
    current = rest;
  }
  if (current) {
    lines.push(current);
  }
  // Ellipsize the final line if it's too long.
  const last = lines.length - 1;
  if (last >= 0 && lines[last].length > maxChars) {
    lines[last] = lines[last].slice(0, maxChars - 1).trimEnd() + "…";
  }
  return lines.slice(0, maxLines);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) {
    return "just now";
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86400)}d ago`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

vscode.postMessage({ type: "ready" });
