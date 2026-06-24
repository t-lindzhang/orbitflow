import * as vscode from "vscode";

export interface WorkContext {
  folderName: string;
  branch?: string;
  recentCommits: string[];
  changedFiles: string[];
  openFiles: string[];
}

interface GitRepoLike {
  state: {
    HEAD?: { name?: string };
    workingTreeChanges: { uri: vscode.Uri }[];
  };
  log(opts: { maxEntries: number }): Promise<{ message: string }[]>;
  diffWithHEAD(): Promise<string>;
}

export async function getGitRepo(): Promise<GitRepoLike | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{
      getAPI(version: number): { repositories: GitRepoLike[] };
    }>("vscode.git");
    if (!ext) {
      return undefined;
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const api = exports.getAPI(1);
    return api.repositories[0];
  } catch {
    return undefined;
  }
}

export async function gatherWorkContext(): Promise<WorkContext> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const folderName = folder?.name ?? "workspace";

  const openFiles: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        openFiles.push(vscode.workspace.asRelativePath(tab.input.uri));
      }
    }
  }

  const ctx: WorkContext = {
    folderName,
    recentCommits: [],
    changedFiles: [],
    openFiles: openFiles.slice(0, 15),
  };

  const repo = await getGitRepo();
  if (repo) {
    ctx.branch = repo.state.HEAD?.name;
    ctx.changedFiles = repo.state.workingTreeChanges
      .map((c) => vscode.workspace.asRelativePath(c.uri))
      .slice(0, 15);
    try {
      const log = await repo.log({ maxEntries: 5 });
      ctx.recentCommits = log.map((c) => c.message.split("\n")[0]);
    } catch {
      /* ignore */
    }
  }

  return ctx;
}

/** Infer a short (< 5 word) goal title for the current work tree. */
export async function inferGoal(ctx: WorkContext): Promise<string> {
  const viaModel = await inferGoalWithModel(ctx);
  if (viaModel) {
    return viaModel;
  }
  return heuristicGoal(ctx);
}

async function inferGoalWithModel(
  ctx: WorkContext
): Promise<string | undefined> {
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (!model) {
      return undefined;
    }
    const prompt = [
      "You name a developer's current work session in 5 words or fewer.",
      "Respond with ONLY the title — no quotes, no punctuation, Title Case.",
      "",
      `Folder: ${ctx.folderName}`,
      ctx.branch ? `Branch: ${ctx.branch}` : "",
      ctx.recentCommits.length
        ? `Recent commits:\n- ${ctx.recentCommits.join("\n- ")}`
        : "",
      ctx.changedFiles.length
        ? `Changed files:\n- ${ctx.changedFiles.join("\n- ")}`
        : "",
      ctx.openFiles.length
        ? `Open files:\n- ${ctx.openFiles.join("\n- ")}`
        : "",
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
    return cleanTitle(text);
  } catch {
    return undefined;
  }
}

function heuristicGoal(ctx: WorkContext): string {
  if (ctx.branch && !["main", "master", "develop"].includes(ctx.branch)) {
    return cleanTitle(ctx.branch.replace(/^(feature|fix|chore|feat)\//, ""));
  }
  if (ctx.recentCommits[0]) {
    return cleanTitle(ctx.recentCommits[0]);
  }
  return cleanTitle(ctx.folderName);
}

function cleanTitle(raw: string): string {
  const words = raw
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(/[_\-/]+/g, " ")
    .replace(/["'`.]+/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const title = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return title || "New Work Tree";
}
