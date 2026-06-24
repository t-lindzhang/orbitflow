import * as vscode from "vscode";
import { getGitRepo } from "./inferGoal";
import { NodeType } from "./types";

export interface ClusteredNode {
  title: string;
  type: NodeType;
  detail: string;
  /** Title of the existing or sibling node this is a subtask of, or "ROOT". */
  parent: string;
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
  private lastDiffSignature = "";
  private running = false;

  private static readonly DEBOUNCE_MS = 8000;
  private static readonly MAX_DIFF_CHARS = 6000;
  private static readonly MAX_FILE_CHARS = 3000;

  constructor(
    private readonly addNodes: AddNodes,
    private readonly getExistingNodes: () => ExistingNode[],
    private readonly log: vscode.LogOutputChannel
  ) {
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

      const changes = repo.state.workingTreeChanges;
      if (changes.length === 0) {
        this.log.debug("No working-tree changes; nothing to detect.");
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

      const signature = `${diff.length}:${diff.slice(0, 200)}`;
      if (signature === this.lastDiffSignature) {
        this.log.debug("Diff unchanged since last run; skipping.");
        return;
      }
      this.lastDiffSignature = signature;

      const changedFiles = changes.map((c) =>
        vscode.workspace.asRelativePath(c.uri)
      );

      this.log.info(
        `Analyzing ${diff.length} chars across ${changedFiles.length} file(s)…`
      );
      const clusters = await clusterChanges(
        diff.slice(0, AutoNodeService.MAX_DIFF_CHARS),
        changedFiles,
        this.getExistingNodes()
      );
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
}

/** Ask the LM to cluster a diff into distinct task nodes. */
async function clusterChanges(
  diff: string,
  changedFiles: string[],
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

    const prompt = [
      "You analyze a developer's uncommitted git diff and identify the",
      "to-do item(s) it represents — the way a person would track work on a",
      "to-do list, NOT individual code edits.",
      "Return ONLY a JSON array, no prose. Each item:",
      '{ "title": string (<=5 words, Title Case),',
      '  "type": "task" | "session" | "idea",',
      '  "detail": string (one sentence),',
      '  "parent": string }',
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
        type: item.type,
        detail:
          typeof item.detail === "string" ? item.detail.trim() : item.title,
        parent:
          typeof item.parent === "string" && item.parent.trim()
            ? item.parent.trim()
            : "ROOT",
      }))
      .slice(0, 5);
  } catch {
    return [];
  }
}
