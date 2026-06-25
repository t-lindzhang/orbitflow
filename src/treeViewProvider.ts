import * as vscode from "vscode";
import { Storage } from "./storage";
import { CaptureService } from "./capture";
import { resumeContext, revealChatSession } from "./resume";
import { gatherWorkContext, inferGoal } from "./inferGoal";
import { ClusteredNode } from "./autoNode";
import { proposeHierarchy } from "./reorganize";
import {
  InboundMessage,
  NodeType,
  OrbitState,
  ResumeContext,
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

/**
 * Common words ignored when scoring how related a chat session is to an
 * existing task node, so generic filler doesn't create false matches.
 */
const SESSION_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "how", "what",
  "why", "when", "where", "which", "should", "could", "would", "can", "are",
  "you", "your", "use", "using", "add", "fix", "make", "get", "set", "new",
]);

export class TreeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "orbitflow.treeView";

  private readonly webviews = new Set<vscode.Webview>();
  private panel?: vscode.WebviewPanel;
  private state: OrbitState;

  /** Snapshots of prior states for revert, plus the last saved baseline. */
  private history: OrbitState[] = [];
  private savedSnapshot: OrbitState;
  private static readonly MAX_HISTORY = 50;

  /** In-flight bootstrap, so concurrent callers never create two trees. */
  private bootstrapping?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: Storage,
    private readonly capture: CaptureService
  ) {
    this.state = this.storage.load();
    this.savedSnapshot = structuredClone(this.state);
    this.history = this.storage.loadHistory();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const kind =
      webviewView.viewType === "orbitflow.listView" ? "list" : "tree";
    // Both views use our React sidebar UI (which includes tree + priority)
    this.registerWebview(webviewView.webview, false, "tree");
    webviewView.onDidDispose(() =>
      this.webviews.delete(webviewView.webview)
    );
  }

  /** Open the focus tree as a full editor tab. */
  openInEditor(): void {
    if (this.panel) {
      try {
        this.panel.reveal(vscode.ViewColumn.Active);
        return;
      } catch {
        // Panel was disposed but reference wasn't cleared
        this.panel = undefined;
      }
    }
    this.panel = vscode.window.createWebviewPanel(
      "orbitflow.graphPanel",
      "OrbitFlow Focus Tree",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.context.extensionUri,
          vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
        ],
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "orbit.svg"
    );
    this.registerWebview(this.panel.webview, true);
    this.panel.onDidDispose(() => {
      if (this.panel) {
        this.webviews.delete(this.panel.webview);
      }
      this.panel = undefined;
    });
  }

  private registerWebview(
    webview: vscode.Webview,
    isPanel: boolean,
    kind: "tree" | "list" = "tree"
  ): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
      ],
    };
    webview.html =
      kind === "list"
        ? this.getListHtml(webview)
        : this.getHtml(webview, isPanel);
    webview.onDidReceiveMessage((msg: InboundMessage) =>
      this.handleMessage(msg)
    );
    this.webviews.add(webview);
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postState();
        // Also send persisted user tasks
        {
          const tasks = this.context.workspaceState.get<any[]>("orbitflow.userTasks.v1") || [];
          for (const webview of this.webviews) {
            try {
              webview.postMessage({ type: "userTasks", tasks });
            } catch { this.webviews.delete(webview); }
          }
        }
        break;
      case "select":
        this.state.activeNodeId = msg.nodeId;
        this.state.activeTreeId =
          this.state.nodes.find((n) => n.id === msg.nodeId)?.treeId ?? null;
        await this.persist(false);
        break;
      case "editNode": {
        const node = this.state.nodes.find((n) => n.id === msg.nodeId);
        if (node) {
          if (msg.title !== undefined) { node.title = msg.title; }
          if (msg.detail !== undefined) { node.detail = msg.detail; }
          await this.persist();
        }
        break;
      }
      case "resume":
        await this.resume(msg.nodeId);
        break;
      case "reveal":
        await this.reveal(msg.nodeId);
        break;
      case "delete":
        await this.deleteNode(msg.nodeId);
        break;
      case "pruneSubtree":
        await this.pruneSubtree(msg.nodeId);
        break;
      case "toggleDone":
        await this.toggleDone(msg.nodeId);
        break;
      case "revert":
        await this.revert();
        break;
      case "generateTrees":
        await this.generateTrees();
        break;
      case "reorganize":
        await this.reorganizeActiveTree();
        break;
      case "clearAll":
        await this.clearAll();
        break;
      case "openGraph":
        this.openInEditor();
        break;
      case "saveUserTasks":
        await this.context.workspaceState.update("orbitflow.userTasks.v1", (msg as any).tasks);
        break;
      case "loadUserTasks": {
        const tasks = this.context.workspaceState.get<any[]>("orbitflow.userTasks.v1") || [];
        for (const webview of this.webviews) {
          try {
            webview.postMessage({ type: "userTasks", tasks });
          } catch { this.webviews.delete(webview); }
        }
        break;
      }
    }
  }

  // ---- Commands (also invoked from the command palette) ----

  /**
   * On startup, automatically detect the current work tree, name it from the
   * inferred goal, and seed it with a root node — no user interaction.
   *
   * Concurrent callers (activation + chat-session detection) share a single
   * in-flight run so we never create two trees for the same workspace.
   */
  async autoBootstrap(): Promise<void> {
    if (this.bootstrapping) {
      await this.bootstrapping;
      return;
    }
    this.bootstrapping = this.doBootstrap();
    try {
      await this.bootstrapping;
    } finally {
      this.bootstrapping = undefined;
    }
  }

  private async doBootstrap(): Promise<void> {
    if (this.state.trees.length > 0) {
      // Already initialised for this workspace — keep everything in one tree
      // and tidy up structure.
      this.state.activeTreeId ??= this.state.trees[0].id;
      let changed = this.consolidateTrees();
      changed = this.normalizeAllTrees() || changed;
      if (changed) {
        await this.persist();
      } else {
        this.postState();
      }
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
      status: "open",
      lastActiveAt: Date.now(),
      detail: this.capture.describe(),
      snapshot: this.capture.snapshot(),
    };

    this.state.nodes.push(node);
    this.state.activeTreeId = tree.id;
    this.state.activeNodeId = node.id;
    await this.persist();
  }

  /**
   * Generate a fresh set of memory trees: discard the current forest and
   * re-detect the work tree(s) from the current workspace context.
   */
  async generateTrees(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Generate a new set of memory trees? This replaces the current trees for this workspace.",
      { modal: true },
      "Generate"
    );
    if (choice !== "Generate") {
      return;
    }
    // Record history (so generate is revertible), then re-detect from scratch.
    this.state = Storage.emptyState();
    await this.persist();
    await this.autoBootstrap();
    vscode.window.setStatusBarMessage(
      "$(refresh) OrbitFlow: generated new memory trees",
      4000
    );
  }

  /** Existing nodes in the active tree, used to nest detected subtasks. */
  getActiveTreeNodes(): { title: string; depth: number }[] {
    const treeId = this.state.activeTreeId;
    if (!treeId) {
      return [];
    }
    return this.state.nodes
      .filter((n) => n.treeId === treeId)
      .map((n) => ({ title: n.title, depth: this.depthOf(n.id) }));
  }

  /** Add nodes detected automatically from code changes (Phase 3). */
  async addAutoNodes(clusters: ClusteredNode[]): Promise<void> {
    if (!clusters.length) {
      return;
    }

    let treeId = this.mainTreeId();
    if (!treeId) {
      await this.autoBootstrap();
      treeId = this.mainTreeId();
    }
    if (!treeId) {
      return;
    }

    // Capture once so every node in this batch shares the same terminal context
    // and active-editor info, but each node's FILES come from its own cluster.
    const context = this.capture.snapshot();

    // Unmatched detections attach to the goal root (depth 1), never to a deep
    // active node — that previously produced a misleading hierarchy.
    const fallbackParent = this.rootOf(treeId);

    // Title -> id map (existing + newly created) so the model can nest under
    // existing nodes OR siblings created in this same batch.
    const titleToId = new Map<string, string>();
    for (const n of this.state.nodes) {
      if (n.treeId === treeId) {
        titleToId.set(n.title.toLowerCase(), n.id);
      }
    }

    let added = 0;

    for (const cluster of clusters) {
      const key = cluster.title.toLowerCase().trim();

      // Check for existing node with same or very similar title
      const existingId = titleToId.get(key) ?? this.findSimilarNode(treeId, key, titleToId);
      if (existingId) {
        // Update the existing node's lastActiveAt instead of creating a duplicate
        const existing = this.state.nodes.find(n => n.id === existingId);
        if (existing) {
          existing.lastActiveAt = Date.now();
          existing.snapshot = this.nodeSnapshot(context, cluster.files);
        }
        continue;
      }

      const parentKey = cluster.parent.trim().toLowerCase();
      let resolvedParent: string | null;
      if (!parentKey || parentKey === "root") {
        // "ROOT" means the single goal root for this tree, not the latest node.
        resolvedParent = this.rootOf(treeId) ?? fallbackParent;
      } else if (titleToId.has(parentKey)) {
        resolvedParent = titleToId.get(parentKey)!;
      } else {
        resolvedParent = fallbackParent;
      }

      const depth = resolvedParent ? this.depthOf(resolvedParent) + 1 : 0;
      const id = genId();

      this.state.nodes.push({
        id,
        treeId,
        parentId: resolvedParent,
        title: cluster.title,
        type: cluster.type,
        relevance: Math.max(0.25, 1 - depth * 0.15),
        urgent: false,
        status: "open",
        lastActiveAt: Date.now(),
        detail: cluster.detail,
        snapshot: this.nodeSnapshot(context, cluster.files),
      });
      titleToId.set(key, id);
      added++;
    }

    if (added > 0) {
      this.normalizeAllTrees();
      await this.persist();
    }
  }

  /**
   * Build a node's resume snapshot from the files it actually owns (absolute
   * fsPaths from its cluster). Terminal commands come from the shared capture;
   * the active-editor cursor line is preserved only if the active file is one
   * of this node's files. No file is ever added that the node doesn't own.
   */
  private nodeSnapshot(
    context: ResumeContext,
    files: string[]
  ): ResumeContext {
    const active = context.files.find((f) => f.active);
    const seen = new Set<string>();
    const out: ResumeContext["files"] = [];
    for (const path of files) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const isActive = active?.path === path;
      out.push({
        path,
        active: isActive || undefined,
        line: isActive ? active?.line : undefined,
      });
    }
    return { files: out, terminalCommands: context.terminalCommands };
  }

  /**
   * Surface a Copilot chat session in the tree as a SINGLE node. A normal
   * working chat is a square "session" node; an exploratory/question-driven
   * chat is a triangular "idea" node instead. A chat never produces both — the
   * node's shape simply reflects what the chat currently looks like.
   */
  async upsertSessionNode(info: {
    sourceId: string;
    title: string;
    detail: string;
    isExploratory?: boolean;
    questionText?: string;
    waiting?: boolean;
    awaitingChoice?: boolean;
    activeMs?: number;
  }): Promise<void> {
    let treeId = this.mainTreeId();
    if (!treeId) {
      await this.autoBootstrap();
      treeId = this.mainTreeId();
    }
    if (!treeId) {
      return;
    }

    // A chat's shape: exploratory chats are ideas (triangles), otherwise the
    // chat is tracked as a session (square).
    const desiredType: NodeType = info.isExploratory ? "idea" : "session";

    // Remove any legacy separate "idea" child previously spawned for this chat,
    // so older state collapses back to a single node per session.
    const legacyIdeaId = `${info.sourceId}#idea`;
    this.state.nodes = this.state.nodes.filter(
      (n) => !(n.sourceId === legacyIdeaId && n.treeId === treeId)
    );

    // 1) The same chat we've already surfaced — update it in place.
    const existing = this.state.nodes.find(
      (n) => n.sourceId === info.sourceId && n.treeId === treeId
    );
    if (existing) {
      existing.title = info.title;
      existing.detail = info.detail;
      existing.type = desiredType;
      existing.lastActiveAt = Date.now();
      this.applySessionSignals(existing, info);
      this.normalizeAllTrees();
      await this.persist();
      return;
    }

    // 2) Dedup — a *different* chat that summarized to a near-identical title
    // folds into the existing node rather than adding another level-1 sibling.
    const key = info.title.toLowerCase().trim();
    const chatTitles = new Map<string, string>();
    for (const n of this.state.nodes) {
      if (
        n.treeId === treeId &&
        (n.type === "session" || n.type === "idea") &&
        n.sourceId?.startsWith("chat:")
      ) {
        chatTitles.set(n.title.toLowerCase(), n.id);
      }
    }
    const dupId = chatTitles.get(key) ?? this.findSimilarNode(treeId, key, chatTitles);
    if (dupId) {
      const dup = this.state.nodes.find((n) => n.id === dupId);
      if (dup) {
        dup.detail = info.detail;
        dup.lastActiveAt = Date.now();
        this.applySessionSignals(dup, info);
      }
      this.normalizeAllTrees();
      await this.persist();
      return;
    }

    // 3) A genuinely new chat — nest it under the most relevant existing task
    // node, falling back to the tree root when nothing is clearly related, so
    // unrelated chats don't all pile onto level 1.
    const parentId = this.relateSessionParent(
      treeId,
      `${info.title} ${info.questionText ?? info.detail}`
    );
    const depth = parentId ? this.depthOf(parentId) + 1 : 0;
    this.state.nodes.push({
      id: genId(),
      treeId,
      parentId,
      title: info.title,
      type: desiredType,
      relevance: Math.max(0.25, 1 - depth * 0.15),
      urgent: false,
      status: "open",
      lastActiveAt: Date.now(),
      detail: info.detail,
      snapshot: this.capture.snapshot(),
      sourceId: info.sourceId,
      waiting: info.waiting ?? false,
      waitingSince: info.waiting ? Date.now() : undefined,
      awaitingChoice: info.awaitingChoice ?? false,
      activeMs: info.activeMs ?? 0,
    });

    this.normalizeAllTrees();
    await this.persist();
  }

  /**
   * Fold a chat session's derived signals (waiting/needs-attention, quick
   * re-prompt, time spent) onto a node. Stamps {@link ThoughtNode.waitingSince}
   * only on the transition into the waiting state — so "longest waiting" rank
   * reflects when the agent first went idle — and clears it once the user
   * re-engages (the chat no longer reads as awaiting a prompt).
   */
  private applySessionSignals(
    node: ThoughtNode,
    info: { waiting?: boolean; awaitingChoice?: boolean; activeMs?: number }
  ): void {
    if (typeof info.activeMs === "number") {
      node.activeMs = info.activeMs;
    }
    const nowWaiting = info.waiting ?? false;
    if (nowWaiting && !node.waiting) {
      node.waitingSince = Date.now();
      // Freshly needs attention again — un-acknowledge so it flashes and
      // re-enters the priority list.
      node.acknowledged = false;
    } else if (!nowWaiting) {
      node.waitingSince = undefined;
    }
    node.waiting = nowWaiting;
    node.awaitingChoice = nowWaiting ? info.awaitingChoice ?? false : false;
  }

  /**
   * Pick the most relevant existing *task* node to nest a chat session under,
   * scored by word overlap between the chat's text and the node's
   * title/detail. Returns the tree root when nothing is a clear match, so
   * unrelated chats surface at the top rather than under an arbitrary task.
   */
  private relateSessionParent(treeId: string, text: string): string | null {
    const root = this.rootOf(treeId);
    const wordsOf = (s: string): Set<string> =>
      new Set(
        (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
          (w) => !SESSION_STOPWORDS.has(w)
        )
      );
    const chatWords = wordsOf(text);
    if (chatWords.size === 0) {
      return root;
    }

    let best: { id: string; score: number } | null = null;
    for (const n of this.state.nodes) {
      if (n.treeId !== treeId || n.type !== "task" || n.id === root) {
        continue;
      }
      if (this.depthOf(n.id) >= 3) {
        continue; // keep the tree shallow
      }
      const nodeWords = wordsOf(`${n.title} ${n.detail ?? ""}`);
      if (nodeWords.size === 0) {
        continue;
      }
      const shared = [...chatWords].filter((w) => nodeWords.has(w)).length;
      if (shared < 2) {
        continue;
      }
      const score = shared / Math.min(chatWords.size, nodeWords.size);
      if (score >= 0.2 && (!best || score > best.score)) {
        best = { id: n.id, score };
      }
    }
    return best?.id ?? root;
  }

  /** Re-cluster the active tree's existing nodes into sensible subtrees. */
  async reorganizeActiveTree(): Promise<void> {
    const treeId = this.state.activeTreeId;
    if (!treeId) {
      return;
    }
    const nodes = this.state.nodes.filter((n) => n.treeId === treeId);
    if (nodes.length < 3) {
      vscode.window.showInformationMessage(
        "OrbitFlow: not enough nodes to reorganize yet."
      );
      return;
    }

    const links = await proposeHierarchy(
      nodes.map((n) => ({ title: n.title, detail: n.detail }))
    );
    if (links.length === 0) {
      vscode.window.showInformationMessage(
        "OrbitFlow: could not propose a reorganization."
      );
      return;
    }

    const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n]));
    const root = nodes.find((n) => n.parentId === null) ?? nodes[0];
    const proposed = new Map<string, string | null>();

    for (const node of nodes) {
      if (node.id === root.id) {
        proposed.set(node.id, null);
        continue;
      }
      const link = links.find(
        (l) => l.title.toLowerCase() === node.title.toLowerCase()
      );
      let parentId: string | null = root.id;
      if (link && link.parent.toLowerCase() !== "root") {
        const parent = byTitle.get(link.parent.toLowerCase());
        if (parent && parent.id !== node.id) {
          parentId = parent.id;
        }
      }
      proposed.set(node.id, parentId);
    }

    // Break any cycles by reattaching offending nodes to the root.
    for (const node of nodes) {
      const seen = new Set<string>();
      let cur: string | null = node.id;
      while (cur) {
        if (seen.has(cur)) {
          proposed.set(node.id, root.id);
          break;
        }
        seen.add(cur);
        cur = proposed.get(cur) ?? null;
      }
    }

    // Commit new parents, then recompute depth-based relevance.
    for (const node of nodes) {
      node.parentId = proposed.get(node.id) ?? null;
    }
    for (const node of nodes) {
      const depth = this.depthOf(node.id);
      node.relevance = Math.max(0.25, 1 - depth * 0.15);
    }

    await this.persist();
    vscode.window.setStatusBarMessage(
      "$(type-hierarchy) OrbitFlow: tree reorganized",
      4000
    );
  }

  async clearAll(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Clear all OrbitFlow memory trees for this workspace? You can undo with Revert.",
      { modal: true },
      "Clear All"
    );
    if (choice !== "Clear All") {
      return;
    }
    this.state = Storage.emptyState();
    await this.persist();
  }

  // ---- helpers ----

  /** The single primary tree everything attaches to. */
  private mainTreeId(): string | null {
    return this.state.trees[0]?.id ?? null;
  }

  /**
   * Merge all trees into the primary (first) one — work for the same overall
   * goal belongs in a single tree, not fragmented across several.
   */
  private consolidateTrees(): boolean {
    if (this.state.trees.length <= 1) {
      return false;
    }
    const primary = this.state.trees[0];
    const primaryRoot = this.state.nodes.find(
      (n) => n.treeId === primary.id && n.parentId === null
    );
    for (const tree of this.state.trees.slice(1)) {
      for (const n of this.state.nodes) {
        if (n.treeId === tree.id) {
          n.treeId = primary.id;
          // Former tree roots hang under the primary tree's root.
          if (n.parentId === null) {
            n.parentId = primaryRoot?.id ?? null;
          }
        }
      }
    }
    this.state.trees = [primary];
    this.state.activeTreeId = primary.id;
    return true;
  }

  /**
   * Guarantee each tree has exactly ONE root. Any stray nodes whose parent is
   * missing (or null) are reattached under the tree's canonical goal root, so
   * work for the same goal stays in a single tree with the root on top.
   */
  private normalizeAllTrees(): boolean {
    let changed = false;
    for (const tree of this.state.trees) {
      const treeNodes = this.state.nodes.filter((n) => n.treeId === tree.id);
      if (treeNodes.length === 0) {
        continue;
      }
      // Migrate older nodes that predate the status field.
      for (const n of treeNodes) {
        if (!n.status) {
          n.status = "open";
          changed = true;
        }
        // Heal self-referential parents (a node can't be its own parent).
        if (n.parentId === n.id) {
          n.parentId = null;
          changed = true;
        }
      }
      const ids = new Set(treeNodes.map((n) => n.id));
      const roots = treeNodes.filter(
        (n) => n.parentId === null || !ids.has(n.parentId)
      );
      const canonical = roots[0] ?? treeNodes[0];
      if (canonical.parentId !== null) {
        canonical.parentId = null;
        changed = true;
      }
      for (const n of treeNodes) {
        if (n.id === canonical.id) {
          continue;
        }
        if (n.parentId === null || !ids.has(n.parentId)) {
          n.parentId = canonical.id;
          changed = true;
        }
      }
    }
    return changed;
  }

  private rootOf(treeId: string): string | null {
    const root = this.state.nodes.find(
      (n) => n.treeId === treeId && n.parentId === null
    );
    return root?.id ?? null;
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

  /** Find an existing node with a similar title (fuzzy match). */
  private findSimilarNode(
    treeId: string,
    key: string,
    titleToId: Map<string, string>
  ): string | null {
    // Check if the key is a substring of any existing title or vice versa
    for (const [existingKey, id] of titleToId) {
      const node = this.state.nodes.find(n => n.id === id);
      if (!node || node.treeId !== treeId) continue;

      // Exact match (already handled, but just in case)
      if (existingKey === key) return id;

      // One contains the other (e.g., "Merge PR" matches "Merge PR 1552780")
      if (existingKey.includes(key) || key.includes(existingKey)) return id;

      // High word overlap (>= 60% of words shared)
      const wordsA = new Set(key.split(/\s+/));
      const wordsB = new Set(existingKey.split(/\s+/));
      const intersection = [...wordsA].filter(w => wordsB.has(w));
      const similarity = intersection.length / Math.max(wordsA.size, wordsB.size);
      if (similarity >= 0.6) return id;
    }
    return null;
  }

  private async resume(nodeId: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    node.lastActiveAt = Date.now();
    this.state.activeNodeId = node.id;
    this.state.activeTreeId = node.treeId;
    // Engaging the node acknowledges it: stop flashing and drop it from the
    // priority list until it needs attention again.
    node.waiting = false;
    node.waitingSince = undefined;
    node.awaitingChoice = false;
    node.acknowledged = true;
    await this.persist();
    await resumeContext(node.snapshot);
  }

  /**
   * Navigate to a node's location without the heavier "resume" restore (no
   * terminal replay, no undo entry). For chat-derived nodes this brings up the
   * Copilot chat session; otherwise it opens the files the task touched.
   */
  private async reveal(nodeId: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    this.state.activeNodeId = node.id;
    this.state.activeTreeId = node.treeId;

    // Coming back to a node acknowledges it: stop the "needs attention" flash
    // until the session next goes idle awaiting a prompt. Safe because the
    // session poller skips unchanged .jsonl files, so waiting won't be
    // re-applied until the conversation actually advances again.
    node.waiting = false;
    node.waitingSince = undefined;
    node.awaitingChoice = false;
    node.acknowledged = true;

    await this.persist(false);

    if (node.sourceId?.startsWith("chat:")) {
      const shown = await revealChatSession(node.sourceId);
      // Chat sessions don't carry meaningful file locations, so we're done once
      // the chat surface is up. Fall back to files only if it couldn't open.
      if (shown) {
        return;
      }
    }
    if (node.snapshot.files.length > 0) {
      await resumeContext(node.snapshot);
    }
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

  /** Remove a node and its entire subtree (everything under that edge). */
  private async pruneSubtree(nodeId: string): Promise<void> {
    const root = this.state.nodes.find((n) => n.id === nodeId);
    if (!root) {
      return;
    }

    // Collect the node and all descendants.
    const toRemove = new Set<string>([nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of this.state.nodes) {
        if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
          toRemove.add(n.id);
          grew = true;
        }
      }
    }

    this.state.nodes = this.state.nodes.filter((n) => !toRemove.has(n.id));
    this.state.trees = this.state.trees.filter((t) =>
      this.state.nodes.some((n) => n.treeId === t.id)
    );
    if (this.state.activeNodeId && toRemove.has(this.state.activeNodeId)) {
      this.state.activeNodeId = null;
    }
    await this.persist();
    vscode.window.setStatusBarMessage(
      `$(trash) OrbitFlow: pruned ${toRemove.size} node(s)`,
      4000
    );
  }

  /** Toggle a node between open and done (manual check-off). */
  private async toggleDone(nodeId: string): Promise<void> {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    node.status = node.status === "done" ? "open" : "done";
    node.lastActiveAt = Date.now();
    await this.persist();
  }

  /** Open (not-done) nodes in the active tree, for commit-completion checks. */
  getOpenNodes(): { title: string; detail: string }[] {
    const treeId = this.state.activeTreeId;
    if (!treeId) {
      return [];
    }
    return this.state.nodes
      .filter((n) => n.treeId === treeId && n.status !== "done")
      .map((n) => ({ title: n.title, detail: n.detail }));
  }

  /** Mark nodes done by title (used by commit-based auto-completion). */
  async markNodesDone(titles: string[]): Promise<void> {
    if (titles.length === 0) {
      return;
    }
    const treeId = this.state.activeTreeId;
    const wanted = new Set(titles.map((t) => t.toLowerCase()));
    let count = 0;
    for (const node of this.state.nodes) {
      if (
        (!treeId || node.treeId === treeId) &&
        node.status !== "done" &&
        wanted.has(node.title.toLowerCase())
      ) {
        node.status = "done";
        node.lastActiveAt = Date.now();
        count++;
      }
    }
    if (count > 0) {
      await this.persist();
      vscode.window.setStatusBarMessage(
        `$(check) OrbitFlow: completed ${count} item(s)`,
        4000
      );
    }
  }

  private async persist(recordHistory = true): Promise<void> {
    if (recordHistory) {
      this.history.push(this.savedSnapshot);
      if (this.history.length > TreeViewProvider.MAX_HISTORY) {
        this.history.shift();
      }
      await this.storage.saveHistory(this.history);
    }
    this.savedSnapshot = structuredClone(this.state);
    await this.storage.save(this.state);
    this.postState();
  }

  /** Revert the tree to its state before the most recent change. */
  async revert(): Promise<void> {
    const previous = this.history.pop();
    if (!previous) {
      vscode.window.showInformationMessage("OrbitFlow: nothing to revert.");
      return;
    }
    this.state = structuredClone(previous);
    this.savedSnapshot = structuredClone(previous);
    await this.storage.saveHistory(this.history);
    await this.storage.save(this.state);
    this.postState();
    vscode.window.setStatusBarMessage(
      "$(discard) OrbitFlow: reverted to previous tree",
      4000
    );
  }

  private postState(): void {
    const priority = this.computePriority();
    for (const webview of this.webviews) {
      try {
        webview.postMessage({ type: "state", state: this.state, priority });
      } catch {
        // Webview may have been disposed — remove it
        this.webviews.delete(webview);
      }
    }
  }

  /**
   * Rank open nodes by what needs attention now. Agent sessions that finished
   * and await a prompt float to the top — the longest-waiting first — followed
   * by urgent work, then high-relevance/stale items. Tasks in a workflow (a
   * top-level branch) the developer has spent more time in are weighted up.
   * NOT a 1:1 tree remap.
   */
  private computePriority(): { id: string; reason: string }[] {
    const treeId = this.mainTreeId();
    if (!treeId) {
      return [];
    }
    const rootId = this.rootOf(treeId);
    const now = Date.now();

    const byId = new Map(this.state.nodes.map((n) => [n.id, n] as const));
    // The "workflow" a node belongs to = its top-level branch (the ancestor
    // that is a direct child of the root). Sum each branch's time spent so we
    // can weight busier workflows higher.
    const branchOf = (nodeId: string): string => {
      let cur = byId.get(nodeId);
      let last = nodeId;
      while (cur && cur.parentId && cur.parentId !== rootId) {
        last = cur.parentId;
        cur = byId.get(cur.parentId);
      }
      return last;
    };
    const branchTimeMs = new Map<string, number>();
    for (const n of this.state.nodes) {
      if (n.treeId !== treeId || n.id === rootId) {
        continue;
      }
      const b = branchOf(n.id);
      branchTimeMs.set(b, (branchTimeMs.get(b) ?? 0) + (n.activeMs ?? 0));
    }

    return this.state.nodes
      .filter(
        (n) =>
          n.treeId === treeId &&
          n.status !== "done" &&
          n.id !== rootId &&
          // Visited since it last needed attention — keep it out of the list
          // until it goes idle awaiting a prompt again (which un-acknowledges).
          !(n.acknowledged && !n.waiting && !n.urgent)
      )
      .map((n) => {
        const ageDays = (now - n.lastActiveAt) / 86_400_000;
        let score = n.relevance * 30 + Math.min(ageDays, 14) * 3;
        // Weight tasks in workflows the developer has invested more time in
        // (capped so a single long session can't dominate everything).
        const branchMin = (branchTimeMs.get(branchOf(n.id)) ?? 0) / 60_000;
        score += Math.min(branchMin, 120) * 0.5;
        let reason = "Important";
        if (n.urgent) {
          score += 100;
          reason = "Urgent";
        } else if (n.waiting) {
          score += 60;
          // Longest-waiting sessions rank first.
          const waitMin = n.waitingSince ? (now - n.waitingSince) / 60_000 : 0;
          score += Math.min(waitMin, 240) * 0.5;
          reason = "Waiting on you";
          if (n.awaitingChoice) {
            // Quick to re-prompt (just pick/confirm) — a light nudge up.
            score += 15;
            reason = "Quick: pick an option";
          }
        } else if (n.type === "session") {
          score += 40;
          reason = "Session needs follow-up";
        } else if (ageDays >= 2) {
          reason = "Stale — revisit";
        }
        return { id: n.id, score, reason };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ id, reason }) => ({ id, reason }));
  }

  private getHtml(webview: vscode.Webview, isPanel: boolean): string {
    const nonce = genId();

    if (!isPanel) {
      // Sidebar: use our React compact tree UI
      const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist", "sidebar.js")
      );
      const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist", "sidebar.css")
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
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    // Editor panel: use our React full tree UI
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist", "fullview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist", "fullview.css")
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
  <title>OrbitFlow Memory Tree</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** A linear, ranked "needs attention" list — the priority view. */
  private getListHtml(webview: vscode.Webview): string {
    const nonce = genId();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    body { margin: 0; padding: 4px; font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    .empty { color: var(--vscode-descriptionForeground); text-align: center;
      margin-top: 24px; }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      border-radius: 5px; cursor: pointer; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .rank { color: var(--vscode-descriptionForeground); font-size: 11px;
      width: 16px; text-align: right; flex: none; }
    .dot { width: 9px; height: 9px; flex: none; }
    .dot.task { border-radius: 50%; }
    .dot.session { border-radius: 2px; }
    .dot.idea { width: 0; height: 0; background: transparent !important;
      border-left: 5px solid transparent; border-right: 5px solid transparent;
      border-bottom: 9px solid currentColor; }
    .main { flex: 1; min-width: 0; }
    .title { display: block; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .reason { display: block; font-size: 10px;
      color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: 4px; flex: none; opacity: 0; }
    .row:hover .actions { opacity: 1; }
    .actions button { background: transparent; color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border); border-radius: 3px;
      cursor: pointer; font-size: 11px; padding: 1px 6px; }
    .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  </style>
</head>
<body>
  <div id="list"><p class="empty">Nothing needs attention yet.</p></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let nodes = [], priority = [], trees = [];
    function color(treeId) {
      const t = trees.find(t => t.id === treeId);
      return t ? t.baseColor : '#888';
    }
    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    window.addEventListener('message', e => {
      if (e.data.type === 'state') {
        nodes = e.data.state.nodes; trees = e.data.state.trees;
        priority = e.data.priority || []; render();
      }
    });
    function render() {
      const byId = {}; nodes.forEach(n => byId[n.id] = n);
      const root = document.getElementById('list');
      if (!priority.length) {
        root.innerHTML = '<p class="empty">Nothing needs attention 🎉</p>';
        return;
      }
      root.innerHTML = '';
      priority.forEach((p, i) => {
        const n = byId[p.id]; if (!n) return;
        const row = document.createElement('div'); row.className = 'row';
        const c = color(n.treeId);
        row.innerHTML =
          '<span class="rank">' + (i + 1) + '</span>' +
          '<span class="dot ' + n.type + '" style="background:' + c + ';color:' + c + '"></span>' +
          '<span class="main"><span class="title">' + esc(n.title) + '</span>' +
          '<span class="reason">' + esc(p.reason) + '</span></span>' +
          '<span class="actions">' +
            '<button data-act="resume">Resume</button>' +
            '<button data-act="done">Done</button>' +
          '</span>';
        row.querySelector('.main').addEventListener('click', () =>
          vscode.postMessage({ type: 'select', nodeId: n.id }));
        row.querySelector('[data-act=resume]').addEventListener('click', ev => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'resume', nodeId: n.id });
        });
        row.querySelector('[data-act=done]').addEventListener('click', ev => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'toggleDone', nodeId: n.id });
        });
        root.appendChild(row);
      });
    }
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function genId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}
