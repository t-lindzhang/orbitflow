import * as vscode from "vscode";
import * as crypto from "crypto";
import { getGitRepo } from "./inferGoal";
import { NodeType } from "./types";

export interface ClusteredNode {
  title: string;
  type: NodeType;
  detail: string;
  /** Title of the existing or sibling node this is a subtask of, or "ROOT". */
  parent: string;
  /**
   * Absolute fsPaths of the files this node covers — the changed file(s) it
   * modifies plus any open reference file the model deemed relevant. Always a
   * subset of files that are actually edited or open (never invented).
   */
  files: string[];
}

/** Callback the service uses to push freshly detected nodes into the tree. */
export type AddNodes = (clusters: ClusteredNode[]) => Promise<void>;

/** Existing node, supplied so detection can nest new subtasks under it. */
export interface ExistingNode {
  title: string;
  depth: number;
}

/**
 * Watches for code changes and, when they settle, asks the language model to
 * cluster the working-tree diff into distinct task nodes — no user interaction.
 */
export class AutoNodeService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Hunk hashes already turned into (or considered for) nodes. */
  private analyzedHunks = new Set<string>();
  /** HEAD commit at last analysis; a change means the diff baseline moved. */
  private lastHeadSha: string | undefined;
  private running = false;

  private static readonly DEBOUNCE_MS = 8000;
  private static readonly MAX_DIFF_CHARS = 6000;
  private static readonly MAX_FILE_CHARS = 3000;
  /** Cap the persisted hash set so it can't grow without bound. */
  private static readonly MAX_HUNK_HASHES = 2000;
  private static readonly STATE_KEY = "orbitflow.autonode.v1";

  /**
   * Scratch/throwaway files that shouldn't spawn task nodes: dotfiles and
   * dot-folders (e.g. `.tmp_inspect.py`, `.vscode/`), and common temp/scratch
   * name patterns. Matched against the basename and each path segment.
   */
  private static readonly IGNORE_BASENAME =
    /^\.|^(tmp|temp|scratch)[._-]|[._-](tmp|temp|bak|swp|orig)$|~$/i;

  private static isIgnorable(uri: vscode.Uri): boolean {
    const segments = uri.path.split("/").filter(Boolean);
    const base = segments[segments.length - 1] ?? "";
    // Ignore if the file itself matches, or if it lives under any dot-folder.
    return (
      AutoNodeService.IGNORE_BASENAME.test(base) ||
      segments.some((seg) => seg.startsWith("."))
    );
  }

  constructor(
    private readonly addNodes: AddNodes,
    private readonly getExistingNodes: () => ExistingNode[],
    private readonly log: vscode.LogOutputChannel,
    private readonly memento?: vscode.Memento
  ) {
    this.hydrateState();
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => this.schedule())
    );
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.run(), AutoNodeService.DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const repo = await getGitRepo();
      if (!repo) {
        this.log.debug("No git repository; skipping detection.");
        return;
      }

      const changes = repo.state.workingTreeChanges.filter(
        (c) => !AutoNodeService.isIgnorable(c.uri)
      );
      if (changes.length === 0) {
        this.log.debug("No trackable working-tree changes; nothing to detect.");
        return;
      }

      const parts = await Promise.all(
        changes.map(async (c) => {
          const d = await repo.diffWithHEAD(c.uri.fsPath).catch(() => "");
          if (d && d.trim()) {
            return d;
          }
          // Untracked/new files produce no diff vs HEAD — synthesize one
          // from their contents so they get detected too.
          return this.synthAddedDiff(c.uri);
        })
      );
      const diff = parts.filter(Boolean).join("\n");
      if (!diff.trim()) {
        this.log.debug("Empty diff; nothing to detect.");
        return;
      }

      // Map each file's repo-relative path to its absolute fsPath. This is the
      // universe of files a node may reference: the changed files plus the
      // files currently open as editor tabs (which the dev may be using as
      // reference). Nothing outside this set can ever be attached to a node.
      const relToFsPath = new Map<string, string>();
      for (const c of changes) {
        relToFsPath.set(
          vscode.workspace.asRelativePath(c.uri).replace(/\\/g, "/"),
          c.uri.fsPath
        );
      }
      const openRel: string[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            const uri = tab.input.uri;
            if (AutoNodeService.isIgnorable(uri)) {
              continue;
            }
            const rel = vscode.workspace.asRelativePath(uri).replace(/\\/g, "/");
            if (!relToFsPath.has(rel)) {
              relToFsPath.set(rel, uri.fsPath);
              openRel.push(rel);
            }
          }
        }
      }

      // Reset the analyzed-hunk memory when HEAD moves (e.g. a commit): the
      // diff baseline has shifted, so previously-seen hunks no longer apply.
      const headSha = repo.state.HEAD?.commit;
      if (headSha !== this.lastHeadSha) {
        this.analyzedHunks.clear();
        this.lastHeadSha = headSha;
      }

      // Only consider hunks we haven't analyzed before, so each run sends the
      // NEW changes rather than the whole HEAD diff every time.
      const hunks = AutoNodeService.splitHunks(diff);
      const newHunks = hunks.filter((h) => !this.analyzedHunks.has(h.hash));
      if (newHunks.length === 0) {
        this.log.debug("No new hunks since last analysis; skipping.");
        return;
      }
      const reducedDiff = newHunks.map((h) => h.text).join("\n");

      const changedFiles = [...new Set(newHunks.map((h) => h.file.replace(/\\/g, "/")))];
      const changedFsPaths = changedFiles
        .map((f) => relToFsPath.get(f))
        .filter((p): p is string => !!p);

      this.log.info(
        `Analyzing ${reducedDiff.length} chars across ${changedFiles.length} file(s), ` +
          `${newHunks.length} new hunk(s)…`
      );
      const clusters = await clusterChanges(
        reducedDiff.slice(0, AutoNodeService.MAX_DIFF_CHARS),
        changedFiles,
        openRel,
        this.getExistingNodes()
      );
      // Mark these hunks analyzed regardless of how many nodes came back, so
      // unchanged work isn't re-sent on every subsequent save.
      for (const h of newHunks) {
        this.analyzedHunks.add(h.hash);
      }
      this.persistState();

      // Resolve each cluster's files to absolute fsPaths, dropping anything the
      // model invented (not in the changed/open universe). If the model gave a
      // node no files AND the whole run is a single node, that node owns all
      // the changed files; otherwise leave it to the model's attribution.
      for (const cluster of clusters) {
        const resolved = cluster.files
          .map((f) => relToFsPath.get(f.replace(/\\/g, "/")))
          .filter((p): p is string => !!p);
        cluster.files =
          resolved.length === 0 && clusters.length === 1
            ? changedFsPaths
            : [...new Set(resolved)];
      }

      if (clusters.length) {
        this.log.info(
          `Detected ${clusters.length} node(s): ${clusters
            .map((c) => c.title)
            .join(", ")}`
        );
        await this.addNodes(clusters);
        vscode.window.setStatusBarMessage(
          `$(git-branch) OrbitFlow: +${clusters.length} node(s)`,
          4000
        );
      } else {
        this.log.info("No distinct tasks detected in the diff.");
      }
    } catch (err) {
      this.log.error(`Detection failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  /** Build an "all additions" diff for an untracked/new file from its contents. */
  private async synthAddedDiff(uri: vscode.Uri): Promise<string> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let text = Buffer.from(bytes).toString("utf8");
      // Skip likely-binary content (NUL byte present).
      if (text.includes("\u0000")) {
        return "";
      }
      if (text.length > AutoNodeService.MAX_FILE_CHARS) {
        text = text.slice(0, AutoNodeService.MAX_FILE_CHARS);
      }
      const rel = vscode.workspace.asRelativePath(uri);
      const body = text
        .split(/\r?\n/)
        .map((line) => `+${line}`)
        .join("\n");
      return `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n${body}`;
    } catch {
      return "";
    }
  }

  /** Load persisted analyzed-hunk hashes + HEAD baseline (survives reloads). */
  private hydrateState(): void {
    const stored = this.memento?.get<{ headSha?: string; hunks?: string[] }>(
      AutoNodeService.STATE_KEY
    );
    this.lastHeadSha = stored?.headSha;
    this.analyzedHunks = new Set(stored?.hunks ?? []);
  }

  /** Persist analyzed-hunk hashes, trimming to the newest MAX_HUNK_HASHES. */
  private persistState(): void {
    if (!this.memento) {
      return;
    }
    let hunks = [...this.analyzedHunks];
    if (hunks.length > AutoNodeService.MAX_HUNK_HASHES) {
      hunks = hunks.slice(-AutoNodeService.MAX_HUNK_HASHES);
      this.analyzedHunks = new Set(hunks);
    }
    void this.memento.update(AutoNodeService.STATE_KEY, {
      headSha: this.lastHeadSha,
      hunks,
    });
  }

  /**
   * Split a unified diff into per-file hunks. Each hunk's hash is derived only
   * from its added/removed line CONTENT (not the `@@` line numbers or context),
   * so edits elsewhere that merely shift line numbers don't make an already
   * seen hunk look new. Also handles the synthetic (no `@@`) untracked-file
   * diffs produced by {@link synthAddedDiff}.
   */
  private static splitHunks(
    diff: string
  ): { file: string; text: string; hash: string }[] {
    interface Hunk {
      textLines: string[];
      content: string[];
    }
    const out: { file: string; text: string; hash: string }[] = [];
    let file = "";
    let header: string[] = [];
    let hunk: Hunk | undefined;

    const flush = (): void => {
      if (hunk && hunk.content.length) {
        const text = [...header, ...hunk.textLines].join("\n");
        const hash = crypto
          .createHash("sha1")
          .update(`${file}\n${hunk.content.join("\n")}`)
          .digest("hex")
          .slice(0, 16);
        out.push({ file, text, hash });
      }
      hunk = undefined;
    };

    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        flush();
        header = [line];
        const m = /b\/(.+)$/.exec(line);
        file = m ? m[1] : "";
        continue;
      }
      if (line.startsWith("@@")) {
        flush();
        hunk = { textLines: [line], content: [] };
        continue;
      }
      if (hunk) {
        hunk.textLines.push(line);
        if (
          (line.startsWith("+") || line.startsWith("-")) &&
          !line.startsWith("+++") &&
          !line.startsWith("---")
        ) {
          hunk.content.push(line);
        }
        continue;
      }
      // Before the first `@@`: header lines, unless this is a synthetic diff
      // whose body starts right after `+++` with no hunk marker.
      if (
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---")
      ) {
        hunk = { textLines: [line], content: [line] };
      } else {
        header.push(line);
      }
    }
    flush();
    return out;
  }
}

/** Ask the LM to cluster a diff into distinct task nodes. */
async function clusterChanges(
  diff: string,
  changedFiles: string[],
  openFiles: string[],
  existing: ExistingNode[]
): Promise<ClusteredNode[]> {
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (!model) {
      return [];
    }

    const existingList = existing.length
      ? existing
          .map((n) => `${"  ".repeat(n.depth)}- ${n.title}`)
          .join("\n")
      : "(none yet)";

    // The model may only attribute files from this explicit list — changed
    // files (edited) plus open tabs (possible references). It must never
    // invent a path or name a file that isn't edited or open.
    const availableFiles = [
      ...changedFiles.map((f) => `- ${f} (changed)`),
      ...openFiles.map((f) => `- ${f} (open)`),
    ].join("\n") || "(none)";

    const prompt = [
      "You analyze a developer's uncommitted git diff and identify the",
      "to-do item(s) it represents — the way a person would track work on a",
      "to-do list, NOT individual code edits.",
      "Return ONLY a JSON array, no prose. Each item:",
      '{ "title": string (<=5 words, Title Case),',
      '  "type": "task" | "idea",',
      '  "detail": string (one sentence),',
      '  "parent": string,',
      '  "files": string[] }',
      "",
      "GRANULARITY (very important):",
      "- Most diffs are ONE coherent to-do item — return a SINGLE node.",
      "- Only return multiple nodes when the diff clearly spans separate,",
      "  independently-trackable pieces of work.",
      "- Do NOT create a node per function/file/edit. Trivial, one-shot, or",
      "  cosmetic changes (formatting, renames, typos, small tweaks) should be",
      "  folded into a larger item or omitted entirely.",
      "- If nothing is worth tracking as a to-do, return [].",
      "",
      "Each title must name the SPECIFIC unit of work (a feature, fix, or",
      "refactor), NOT the overall project or tech stack.",
      'GOOD: "Add Memory Tree Zoom", "Fix Edge Pruning".',
      'BAD: "Building VS Code Extension", "Update main.ts", "Change Variable".',
      "",
      "NESTING (grow the tree in DEPTH, not just breadth):",
      "- Set 'parent' to the EXACT title of the existing node this change",
      "  refines, continues, or is a subtask of.",
      "- If a new task is a subtask of ANOTHER new task in your output, set",
      "  'parent' to that new task's title.",
      "- Only use \"ROOT\" when the change starts a genuinely new top-level",
      "  thread unrelated to existing nodes.",
      "Prefer nesting under a relevant parent over adding a new top-level node.",
      "",
      "Existing nodes (indented by depth):",
      existingList,
      "",
      "Use 'idea' for exploratory/research changes, 'task' for concrete work.",
      "",
      "FILES (for resuming this work later):",
      "- Set 'files' to the changed file(s) this item modifies.",
      "- You MAY also add an OPEN file if it is clearly a reference for this",
      "  item, but only when genuinely relevant.",
      "- Choose ONLY from the Available files list below. NEVER invent a path",
      "  or include a file that is not listed there.",
      "",
      "Available files (choose 'files' ONLY from these):",
      availableFiles,
      "",
      `Changed files: ${changedFiles.join(", ") || "(unknown)"}`,
      "",
      "Diff:",
      diff,
    ].join("\n");

    const source = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      source.token
    );
    let text = "";
    for await (const chunk of response.text) {
      text += chunk;
    }
    return parseClusters(text);
  } catch {
    return [];
  }
}

function parseClusters(raw: string): ClusteredNode[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    const valid: NodeType[] = ["task", "session", "idea"];
    return parsed
      .map((item) => item as Partial<ClusteredNode>)
      .filter(
        (item): item is ClusteredNode =>
          typeof item.title === "string" &&
          item.title.trim().length > 0 &&
          valid.includes(item.type as NodeType)
      )
      .map((item) => ({
        title: item.title.trim().split(/\s+/).slice(0, 5).join(" "),
        // Squares are reserved for real Copilot chat sessions; diff-derived
        // nodes can only be tasks or ideas. Clamp any stray "session".
        type: item.type === "session" ? "task" : item.type,
        detail:
          typeof item.detail === "string" ? item.detail.trim() : item.title,
        parent:
          typeof item.parent === "string" && item.parent.trim()
            ? item.parent.trim()
            : "ROOT",
        files: Array.isArray(item.files)
          ? item.files.filter((f): f is string => typeof f === "string")
          : [],
      }))
      .slice(0, 5);
  } catch {
    return [];
  }
}
