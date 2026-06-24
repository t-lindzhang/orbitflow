import * as vscode from "vscode";
import { getGitRepo } from "./inferGoal";
import { NodeType } from "./types";

export interface ClusteredNode {
  title: string;
  type: NodeType;
  detail: string;
}

/** Callback the service uses to push freshly detected nodes into the tree. */
export type AddNodes = (clusters: ClusteredNode[]) => Promise<void>;

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

  constructor(private readonly addNodes: AddNodes) {
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
        return;
      }
      const diff = (await repo.diffWithHEAD()) ?? "";
      if (!diff.trim()) {
        return;
      }

      const signature = `${diff.length}:${diff.slice(0, 200)}`;
      if (signature === this.lastDiffSignature) {
        return;
      }
      this.lastDiffSignature = signature;

      const changedFiles = repo.state.workingTreeChanges.map((c) =>
        vscode.workspace.asRelativePath(c.uri)
      );

      const clusters = await clusterChanges(
        diff.slice(0, AutoNodeService.MAX_DIFF_CHARS),
        changedFiles
      );
      if (clusters.length) {
        await this.addNodes(clusters);
      }
    } catch {
      /* best-effort; ignore failures */
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
}

/** Ask the LM to cluster a diff into distinct task nodes. */
async function clusterChanges(
  diff: string,
  changedFiles: string[]
): Promise<ClusteredNode[]> {
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (!model) {
      return [];
    }

    const prompt = [
      "You analyze a developer's uncommitted git diff and split it into the",
      "distinct tasks it represents (usually 1-3).",
      "Return ONLY a JSON array, no prose. Each item:",
      '{ "title": string (<=5 words, Title Case),',
      '  "type": "task" | "session" | "idea",',
      '  "detail": string (one sentence) }',
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
      }))
      .slice(0, 5);
  } catch {
    return [];
  }
}
