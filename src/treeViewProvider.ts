import * as vscode from "vscode";
import { Storage } from "./storage";
import { CaptureService } from "./capture";
import { resumeContext } from "./resume";
import { gatherWorkContext, inferGoal } from "./inferGoal";
import { ClusteredNode } from "./autoNode";
import {
  InboundMessage,
  NodeType,
  OrbitState,
  ThoughtNode,
  Tree,
} from "./types";

const TREE_COLORS = [
  "#4f9cff",
  "#ff8a4f",
  "#5fd07f",
  "#c77dff",
  "#ffd166",
  "#ff6b9d",
  "#36c9c6",
];

export class TreeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "orbitflow.treeView";

  private view?: vscode.WebviewView;
  private state: OrbitState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: Storage,
    private readonly capture: CaptureService
  ) {
    this.state = this.storage.load();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) =>
      this.handleMessage(msg)
    );
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postState();
        break;
      case "select":
        this.state.activeNodeId = msg.nodeId;
        this.state.activeTreeId =
          this.state.nodes.find((n) => n.id === msg.nodeId)?.treeId ?? null;
        await this.persist();
        break;
      case "resume":
        await this.resume(msg.nodeId);
        break;
      case "delete":
        await this.deleteNode(msg.nodeId);
        break;
      case "newTree":
        await this.newTree();
        break;
      case "captureNode":
        await this.captureNode();
        break;
    }
  }

  // ---- Commands (also invoked from the command palette) ----

  /**
   * On startup, automatically detect the current work tree, name it from the
   * inferred goal, and seed it with a root node — no user interaction.
   */
  async autoBootstrap(): Promise<void> {
    if (this.state.trees.length > 0) {
      // Already initialised for this workspace.
      this.state.activeTreeId ??= this.state.trees[0].id;
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const goal = await inferGoal(await gatherWorkContext());
    const tree = this.createTree(goal);

    const node: ThoughtNode = {
      id: genId(),
      treeId: tree.id,
      parentId: null,
      title: goal,
      type: "task",
      relevance: 1,
      urgent: false,
      lastActiveAt: Date.now(),
      detail: this.capture.describe(),
      snapshot: this.capture.snapshot(),
    };

    this.state.nodes.push(node);
    this.state.activeTreeId = tree.id;
    this.state.activeNodeId = node.id;
    await this.persist();
  }

  /** Capture the current context as a new node — silent, auto-named. */
  async captureNode(): Promise<void> {
    let treeId = this.state.activeTreeId;
    if (!treeId || !this.state.trees.some((t) => t.id === treeId)) {
      const goal = await inferGoal(await gatherWorkContext());
      treeId = this.createTree(goal).id;
      this.state.activeNodeId = null;
    }

    const parentId =
      this.state.activeNodeId &&
      this.state.nodes.find(
        (n) => n.id === this.state.activeNodeId && n.treeId === treeId
      )
        ? this.state.activeNodeId
        : this.rootOf(treeId);

    const depth = parentId ? this.depthOf(parentId) + 1 : 0;

    const node: ThoughtNode = {
      id: genId(),
      treeId,
      parentId,
      title: this.inferNodeTitle(),
      type: "task",
      relevance: Math.max(0.25, 1 - depth * 0.15),
      urgent: false,
      lastActiveAt: Date.now(),
      detail: this.capture.describe(),
      snapshot: this.capture.snapshot(),
    };

    this.state.nodes.push(node);
    this.state.activeNodeId = node.id;
    this.state.activeTreeId = treeId;
    await this.persist();
  }

  async newTree(): Promise<void> {
    const goal = await inferGoal(await gatherWorkContext());
    const tree = this.createTree(goal);
    this.state.activeTreeId = tree.id;
    this.state.activeNodeId = null;
    await this.persist();
  }

  /** Add nodes detected automatically from code changes (Phase 3). */
  async addAutoNodes(clusters: ClusteredNode[]): Promise<void> {
    if (!clusters.length) {
      return;
    }

    let treeId = this.state.activeTreeId;
    if (!treeId || !this.state.trees.some((t) => t.id === treeId)) {
      await this.autoBootstrap();
      treeId = this.state.activeTreeId;
    }
    if (!treeId) {
      return;
    }

    const parentId =
      this.state.activeNodeId &&
      this.state.nodes.find(
        (n) => n.id === this.state.activeNodeId && n.treeId === treeId
      )
        ? this.state.activeNodeId
        : this.rootOf(treeId);

    const depth = parentId ? this.depthOf(parentId) + 1 : 0;
    let added = 0;

    for (const cluster of clusters) {
      const duplicate = this.state.nodes.some(
        (n) =>
          n.treeId === treeId &&
          n.title.toLowerCase() === cluster.title.toLowerCase()
      );
      if (duplicate) {
        continue;
      }

      this.state.nodes.push({
        id: genId(),
        treeId,
        parentId,
        title: cluster.title,
        type: cluster.type,
        relevance: Math.max(0.25, 1 - depth * 0.15),
        urgent: false,
        lastActiveAt: Date.now(),
        detail: cluster.detail,
        snapshot: this.capture.snapshot(),
      });
      added++;
    }

    if (added > 0) {
      await this.persist();
    }
  }

  async clearAll(): Promise<void> {
    await this.storage.clear();
    this.state = this.storage.load();
    this.postState();
  }

  // ---- helpers ----

  private rootOf(treeId: string): string | null {
    const root = this.state.nodes.find(
      (n) => n.treeId === treeId && n.parentId === null
    );
    return root?.id ?? null;
  }

  private inferNodeTitle(): string {
    const active = vscode.window.activeTextEditor;
    if (active) {
      const base = active.document.uri.path.split("/").pop() ?? "Edit";
      return base.replace(/\.[^.]+$/, "");
    }
    return this.capture.describe();
  }

  private createTree(title: string): Tree {
    const tree: Tree = {
      id: genId(),
      title: title.slice(0, 40),
      baseColor: TREE_COLORS[this.state.trees.length % TREE_COLORS.length],
      createdAt: Date.now(),
    };
    this.state.trees.push(tree);
    return tree;
  }

  private depthOf(nodeId: string): number {
    let depth = 0;
    let current = this.state.nodes.find((n) => n.id === nodeId);
    while (current?.parentId) {
      depth++;
      current = this.state.nodes.find((n) => n.id === current!.parentId);
    }
    return depth;
  }

  private async resume(nodeId: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    node.lastActiveAt = Date.now();
    this.state.activeNodeId = node.id;
    this.state.activeTreeId = node.treeId;
    await this.persist();
    await resumeContext(node.snapshot);
  }

  private async deleteNode(nodeId: string): Promise<void> {
    // Re-parent children to the deleted node's parent.
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    for (const child of this.state.nodes) {
      if (child.parentId === nodeId) {
        child.parentId = node.parentId;
      }
    }
    this.state.nodes = this.state.nodes.filter((n) => n.id !== nodeId);
    // Drop empty trees.
    this.state.trees = this.state.trees.filter((t) =>
      this.state.nodes.some((n) => n.treeId === t.id)
    );
    if (this.state.activeNodeId === nodeId) {
      this.state.activeNodeId = null;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.storage.save(this.state);
    this.postState();
  }

  private postState(): void {
    this.view?.webview.postMessage({ type: "state", state: this.state });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = genId();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>OrbitFlow</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-capture" title="Capture current context">+</button>
  </div>
  <div id="empty" class="hidden">
    <p>Watching your work…</p>
    <p>Nodes appear automatically as you change code.</p>
  </div>
  <svg id="graph"></svg>
  <div id="card" class="hidden"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function genId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}
