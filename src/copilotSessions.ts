import * as vscode from "vscode";

export interface SessionInfo {
  sourceId: string;
  title: string;
  detail: string;
}

export type UpsertSession = (info: SessionInfo) => Promise<void>;

/**
 * Best-effort detection of VS Code chat (Copilot) sessions. Watches the
 * workspace's `chatSessions` store and surfaces each session as a node.
 * Fails gracefully (no-op) if the store can't be located or parsed.
 */
export class CopilotSessionService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: vscode.FileSystemWatcher;

  private static readonly MAX_SEED = 10;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly upsert: UpsertSession,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async start(): Promise<void> {
    const dir = this.sessionsDir();
    if (!dir) {
      return;
    }

    try {
      await vscode.workspace.fs.stat(dir);
    } catch {
      this.log.debug(`No chat sessions store at ${dir.fsPath}.`);
      return;
    }

    await this.seedExisting(dir);

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, "*.jsonl")
    );
    const onChange = (uri: vscode.Uri) => void this.handle(uri);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(onChange),
      this.watcher.onDidChange(onChange)
    );
    this.log.info(`Watching chat sessions in ${dir.fsPath}`);
  }

  /** workspaceStorage/<id>/chatSessions — derived from this extension's storage. */
  private sessionsDir(): vscode.Uri | undefined {
    const storage = this.context.storageUri;
    if (!storage) {
      return undefined;
    }
    // storageUri = workspaceStorage/<id>/<publisher.ext>; go up one level.
    const workspaceStorage = vscode.Uri.joinPath(storage, "..");
    return vscode.Uri.joinPath(workspaceStorage, "chatSessions");
  }

  private async seedExisting(dir: vscode.Uri): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const files = entries
        .filter(
          ([name, type]) =>
            type === vscode.FileType.File && name.endsWith(".jsonl")
        )
        .map(([name]) => name)
        .slice(-CopilotSessionService.MAX_SEED);
      for (const name of files) {
        await this.handle(vscode.Uri.joinPath(dir, name));
      }
    } catch {
      /* ignore */
    }
  }

  private async handle(uri: vscode.Uri): Promise<void> {
    const info = await this.parse(uri);
    if (info) {
      await this.upsert(info);
    }
  }

  private async parse(uri: vscode.Uri): Promise<SessionInfo | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");

      // JSONL: each line is an event; the kind:0 line holds the session object.
      let session:
        | { customTitle?: string; requests?: unknown[] }
        | undefined;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const obj = JSON.parse(line) as {
            v?: { customTitle?: string; requests?: unknown[] };
            customTitle?: string;
            requests?: unknown[];
          };
          const v = obj.v ?? obj;
          if (v && (Array.isArray(v.requests) || v.customTitle)) {
            session = v;
            break;
          }
        } catch {
          /* skip malformed line */
        }
      }

      const requests: unknown[] = Array.isArray(session?.requests)
        ? session!.requests
        : [];
      if (requests.length === 0) {
        return undefined;
      }

      const firstText = this.requestText(requests[0]);
      const title =
        typeof session?.customTitle === "string" && session.customTitle.trim()
          ? session.customTitle.trim()
          : this.toTitle(firstText) || "Chat Session";
      const detail = `${requests.length} request(s)${
        firstText ? ` · “${firstText.slice(0, 80)}”` : ""
      }`;

      const sourceId = `chat:${uri.path.split("/").pop() ?? uri.path}`;
      return { sourceId, title: title.slice(0, 60), detail };
    } catch {
      return undefined;
    }
  }

  private requestText(request: unknown): string {
    const r = request as {
      message?: { text?: string; parts?: { text?: string }[] };
    };
    const msg = r?.message;
    if (typeof msg?.text === "string" && msg.text.trim()) {
      return msg.text.trim();
    }
    if (Array.isArray(msg?.parts)) {
      const joined = msg.parts
        .map((p) => p?.text ?? "")
        .join(" ")
        .trim();
      if (joined) {
        return joined;
      }
    }
    return "";
  }

  private toTitle(text: string): string {
    const words = text
      .replace(/[\r\n]+/g, " ")
      .replace(/[`"'.]+/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    return words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
