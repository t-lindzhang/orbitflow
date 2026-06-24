import * as vscode from "vscode";
import { getGitRepo } from "./inferGoal";

interface Repo {
  state: {
    HEAD?: { name?: string; commit?: string };
    onDidChange: vscode.Event<void>;
  };
  log(opts: { maxEntries: number }): Promise<{ message: string }[]>;
  diffBetween(ref1: string, ref2: string): Promise<{ uri: vscode.Uri }[]>;
}

export type MarkDone = (titles: string[]) => Promise<void>;
export type GetOpenNodes = () => { title: string; detail: string }[];

/**
 * Watches for new commits and asks the model which open to-do nodes the commit
 * completes, then marks them done — making the tree behave like a to-do list.
 */
export class CommitCompletionService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private lastCommit?: string;
  private running = false;

  constructor(
    private readonly getOpenNodes: GetOpenNodes,
    private readonly markDone: MarkDone,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async start(): Promise<void> {
    const repo = (await getGitRepo()) as unknown as Repo | undefined;
    if (!repo) {
      return;
    }
    this.lastCommit = repo.state.HEAD?.commit;
    this.disposables.push(
      repo.state.onDidChange(() => void this.onChange(repo))
    );
    this.log.info("Watching commits for to-do completion.");
  }

  private async onChange(repo: Repo): Promise<void> {
    const current = repo.state.HEAD?.commit;
    if (!current || current === this.lastCommit || this.running) {
      return;
    }
    const previous = this.lastCommit;
    this.lastCommit = current;
    if (!previous) {
      return;
    }
    this.running = true;
    try {
      await this.handleCommit(repo, previous, current);
    } catch (err) {
      this.log.error(`Completion check failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async handleCommit(
    repo: Repo,
    previous: string,
    current: string
  ): Promise<void> {
    const open = this.getOpenNodes();
    if (open.length === 0) {
      return;
    }

    const message =
      (await repo.log({ maxEntries: 1 }).catch(() => []))[0]?.message ?? "";
    const files = await repo
      .diffBetween(previous, current)
      .then((changes) =>
        changes.map((c) => vscode.workspace.asRelativePath(c.uri))
      )
      .catch(() => [] as string[]);

    const done = await this.askCompleted(message, files, open);
    if (done.length) {
      this.log.info(`Commit completed: ${done.join(", ")}`);
      await this.markDone(done);
    }
  }

  private async askCompleted(
    message: string,
    files: string[],
    open: { title: string; detail: string }[]
  ): Promise<string[]> {
    try {
      const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (!model) {
        return [];
      }

      const list = open
        .map((n) => `- ${n.title}${n.detail ? ` — ${n.detail}` : ""}`)
        .join("\n");

      const prompt = [
        "A developer just made a git commit. Decide which of their open",
        "to-do items this commit COMPLETES (fully addresses).",
        "Be conservative — only include an item if the commit clearly finishes",
        "it. Return ONLY a JSON array of the EXACT titles completed, or [].",
        "",
        `Commit message: ${message || "(none)"}`,
        files.length ? `Changed files:\n- ${files.join("\n- ")}` : "",
        "",
        "Open to-do items:",
        list,
      ]
        .filter(Boolean)
        .join("\n");

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
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        return [];
      }
      const parsed = JSON.parse(match[0]) as unknown[];
      const titles = new Set(open.map((n) => n.title.toLowerCase()));
      return parsed
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => titles.has(t.toLowerCase()));
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
