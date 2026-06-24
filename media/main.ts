import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceCollide,
  Simulation,
  SimulationLinkDatum,
  SimulationNodeDatum,
} from "d3-force";
import { drag } from "d3-drag";
import { select } from "d3-selection";
import type { OrbitState, OutboundMessage, ThoughtNode } from "../src/types";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type GNode = ThoughtNode & SimulationNodeDatum;
interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode | string;
  target: GNode | string;
}

let state: OrbitState = {
  trees: [],
  nodes: [],
  activeNodeId: null,
  activeTreeId: null,
};
let sim: Simulation<GNode, GLink> | null = null;
let stickyNodeId: string | null = null;

const svg = select<SVGSVGElement, unknown>("#graph");
const card = document.getElementById("card")!;
const empty = document.getElementById("empty")!;

document
  .getElementById("btn-capture")!
  .addEventListener("click", () => vscode.postMessage({ type: "captureNode" }));

window.addEventListener("message", (e: MessageEvent<OutboundMessage>) => {
  if (e.data.type === "state") {
    state = e.data.state;
    render();
  }
});

window.addEventListener("resize", () => render());

function treeColor(treeId: string): string {
  return state.trees.find((t) => t.id === treeId)?.baseColor ?? "#888";
}

/** Blend a hex color toward gray based on relevance (1 = full color). */
function relevanceColor(hex: string, relevance: number): string {
  const c = hexToRgb(hex);
  const gray = 128;
  const t = Math.max(0, Math.min(1, relevance));
  const mix = (v: number) => Math.round(gray + (v - gray) * t);
  return `rgb(${mix(c.r)}, ${mix(c.g)}, ${mix(c.b)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function buildLinks(nodes: GNode[]): GLink[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => n.parentId && ids.has(n.parentId))
    .map((n) => ({ source: n.parentId as string, target: n.id }));
}

function render(): void {
  const width = svg.node()!.clientWidth || 400;
  const height = svg.node()!.clientHeight || 600;

  empty.classList.toggle("hidden", state.nodes.length > 0);

  const nodes: GNode[] = state.nodes.map((n) => ({ ...n }));
  const links = buildLinks(nodes);

  svg.selectAll("*").remove();

  const linkSel = svg
    .append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link");

  const nodeSel = svg
    .append("g")
    .attr("class", "nodes")
    .selectAll<SVGGElement, GNode>("g")
    .data(nodes, (d) => d.id)
    .join("g")
    .attr("class", "node")
    .style("cursor", "pointer");

  nodeSel.each(function (d) {
    const g = select(this);
    const fill = relevanceColor(treeColor(d.treeId), d.relevance);
    const r = 10;
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

    if (d.urgent) {
      g.append("circle")
        .attr("r", r + 5)
        .attr("class", "urgent-ring");
    }

    g.append("text")
      .attr("class", "label")
      .attr("x", r + 6)
      .attr("y", 4)
      .text(d.title);

    g.append("text")
      .attr("class", "sublabel")
      .attr("x", r + 6)
      .attr("y", 18)
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

  nodeSel.call(
    drag<SVGGElement, GNode>()
      .on("start", (event, d) => {
        if (!event.active) {
          sim?.alphaTarget(0.2).restart();
        }
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) {
          sim?.alphaTarget(0);
        }
        d.fx = null;
        d.fy = null;
      })
  );

  sim = forceSimulation<GNode>(nodes)
    .force(
      "link",
      forceLink<GNode, GLink>(links)
        .id((d) => d.id)
        .distance(70)
        .strength(0.6)
    )
    .force("charge", forceManyBody().strength(-220))
    .force("center", forceCenter(width / 2, height / 2))
    .force("collide", forceCollide(28))
    .on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as GNode).x ?? 0)
        .attr("y1", (d) => (d.source as GNode).y ?? 0)
        .attr("x2", (d) => (d.target as GNode).x ?? 0)
        .attr("y2", (d) => (d.target as GNode).y ?? 0);
      nodeSel.attr("transform", (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
    });
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
    <div class="card-meta">${node.type} · ${timeAgo(node.lastActiveAt)}</div>
    <div class="card-detail">${escapeHtml(node.detail)}</div>
    ${files ? `<ul class="card-files">${files}</ul>` : ""}
    ${
      sticky
        ? `<div class="card-actions">
            <button id="card-resume">Resume</button>
            <button id="card-delete" class="danger">Delete</button>
          </div>`
        : ""
    }
  `;
  card.classList.remove("hidden");

  if (sticky) {
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
