import * as vscode from "vscode";

/** Minimal shape of a persisted chat request we read the user's prompt from. */
interface RawRequest {
  requestId?: string;
  message?: { text?: string; parts?: { text?: string }[] };
}

export interface SessionInfo {
  sourceId: string;
  title: string;
  detail: string;
  /**
   * True when the chat contains exploratory/question-driven prompts (the
   * developer is asking about a topic rather than only tracking concrete
   * work). Such chats spawn a triangular "idea" child node.
   */
  isExploratory: boolean;
  /** Concatenated user prompts, used to relate the chat to an existing task. */
  questionText: string;
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
  private pollTimer?: ReturnType<typeof setInterval>;
  /** Last seen size+mtime per session file, to skip unchanged files on rescan. */
  private readonly fileStamps = new Map<string, string>();

  private static readonly MAX_SEED = 5;
  /**
   * Minimum combined prompt length for a chat to be worth surfacing. Shorter
   * chats (a one-word prompt, a greeting) are throwaway and only add clutter.
   */
  private static readonly MIN_PROMPT_CHARS = 20;
  /**
   * How often to rescan the chat store. The store lives outside the workspace
   * folder, where VS Code's file watcher does not deliver content-change
   * (`onDidChange`) events, so polling is the only reliable way to notice that
   * the active session has grown.
   */
  private static readonly POLL_MS = 5000;

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

    await this.rescan(dir);

    // Primary mechanism: poll the store. The chat files live outside the
    // workspace folder, so `onDidChange` from a FileSystemWatcher is not
    // delivered for the live session; a timer is the dependable fallback.
    this.pollTimer = setInterval(() => void this.rescan(dir), CopilotSessionService.POLL_MS);

    // Rescan immediately when the window regains focus — cheap and catches up
    // the moment the user returns from another app.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.rescan(dir);
        }
      })
    );

    // Best-effort watcher too: harmless if events never fire, and on some
    // platforms create/delete events still arrive.
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, "*.jsonl")
    );
    const onChange = (uri: vscode.Uri) => void this.handle(uri);
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(onChange),
      this.watcher.onDidChange(onChange)
    );
    this.log.info(`Watching chat sessions in ${dir.fsPath} (poll ${CopilotSessionService.POLL_MS}ms)`);
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

  /**
   * Re-read the chat store and (re)parse any session file that is new or has
   * changed size/mtime since we last looked. Cheap to call frequently because
   * unchanged files are skipped via {@link fileStamps}.
   */
  private async rescan(dir: vscode.Uri): Promise<void> {
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
        const uri = vscode.Uri.joinPath(dir, name);
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          const stamp = `${stat.size}:${stat.mtime}`;
          if (this.fileStamps.get(name) === stamp) {
            continue; // unchanged since last scan
          }
          this.fileStamps.set(name, stamp);
        } catch {
          continue;
        }
        await this.handle(uri);
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

      // The chat store is a delta log, NOT a single snapshot:
      //   kind:0  -> base session object (v.requests holds the FIRST request)
      //   kind:2  -> append: v is items pushed onto the array at path k
      //   kind:1  -> set: replace the value at path k with v
      // We must replay these to see follow-up prompts, otherwise only the very
      // first request is ever observed. Collect requests by id, in order.
      const requestsById = new Map<string, RawRequest>();
      const addRequest = (r: unknown): void => {
        const req = r as RawRequest;
        if (req && typeof req === "object" && typeof req.requestId === "string") {
          requestsById.set(req.requestId, req);
        }
      };
      let customTitle: string | undefined;

      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const obj = JSON.parse(line) as {
            kind?: number;
            k?: unknown[];
            v?: unknown;
            customTitle?: string;
            requests?: unknown[];
          };

          // Base snapshot (kind:0) — also handles the legacy single-object form.
          if (obj.kind === 0 || obj.customTitle || Array.isArray(obj.requests)) {
            const base = (obj.v ?? obj) as {
              customTitle?: string;
              requests?: unknown[];
            };
            if (typeof base.customTitle === "string") {
              customTitle = base.customTitle;
            }
            if (Array.isArray(base.requests)) {
              base.requests.forEach(addRequest);
            }
            continue;
          }

          // Delta touching the requests array.
          const k = obj.k;
          if (Array.isArray(k) && k[0] === "requests") {
            if (k.length === 1 && Array.isArray(obj.v)) {
              // Append (or whole-array set) of request objects.
              obj.v.forEach(addRequest);
            } else if (
              k.length === 2 &&
              typeof k[1] === "number" &&
              obj.v &&
              typeof obj.v === "object"
            ) {
              // Replace a specific request slot.
              addRequest(obj.v);
            }
            // Deeper patches (e.g. ["requests", N, "result"]) don't change the
            // user's prompt text, so they're ignored.
          }
        } catch {
          /* skip malformed line */
        }
      }

      const requests = [...requestsById.values()];
      if (requests.length === 0) {
        return undefined;
      }

      const texts = requests
        .map((r) => this.requestText(r))
        .filter((t) => t.length > 0);

      // Skip insubstantial chats so the tree isn't cluttered with throwaway
      // sessions (single greeting / one-word prompt).
      if (texts.join(" ").trim().length < CopilotSessionService.MIN_PROMPT_CHARS) {
        return undefined;
      }

      // The persisted session title is usually a stale first prompt, so we
      // re-summarize from all prompts into a short title + real description.
      const summary = await this.summarize(texts, customTitle);

      const sourceId = `chat:${uri.path.split("/").pop() ?? uri.path}`;
      return {
        sourceId,
        title: summary.title.slice(0, 60),
        detail: summary.description.slice(0, 200),
        isExploratory: this.isExploratory(texts),
        questionText: texts.join(" • ").slice(0, 400),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the language model for a concise (<=5 word) title and a one-sentence
   * description summarizing what the chat is about. Falls back to a heuristic
   * derived from the first prompt / persisted title when no model is available.
   */
  private async summarize(
    texts: string[],
    customTitle?: string
  ): Promise<{ title: string; description: string }> {
    const fallback = {
      title:
        this.toTitle(texts[0] ?? customTitle ?? "") ||
        (customTitle?.trim() ? this.toTitle(customTitle) : "") ||
        "Chat Session",
      description: texts[0]
        ? texts[0].slice(0, 140)
        : "Copilot chat session.",
    };
    const joined = texts.join("\n").slice(0, 2000);
    if (!joined.trim()) {
      return fallback;
    }
    try {
      const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (!model) {
        return fallback;
      }
      const prompt = [
        "Summarize this Copilot chat for a to-do board card.",
        "Return ONLY a JSON object, no prose:",
        '{ "title": string (<=5 words, Title Case, names the work or topic),',
        '  "description": string (one short sentence) }',
        "The title must describe the SUBJECT of the chat, NOT be a generic",
        'label or a verbatim old prompt. GOOD: "Fix Edge Pruning",',
        '"Explore Tree Layout". BAD: "Chat Session", "Help Me".',
        "",
        "Chat prompts (most recent last):",
        joined,
      ].join("\n");
      const source = new vscode.CancellationTokenSource();
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        source.token
      );
      let raw = "";
      for await (const chunk of response.text) {
        raw += chunk;
      }
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        return fallback;
      }
      const parsed = JSON.parse(match[0]) as {
        title?: unknown;
        description?: unknown;
      };
      const title =
        typeof parsed.title === "string" && parsed.title.trim()
          ? this.toTitle(parsed.title)
          : fallback.title;
      const description =
        typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description.trim()
          : fallback.description;
      return { title, description };
    } catch {
      return fallback;
    }
  }

  /** Question-shaped prompts: interrogatives, "?", or uncertainty markers. */
  private static readonly QUESTION_WORDS =
    /^(how|what|why|when|where|which|who|should|could|would|can|is|are|do|does|did|explain|tell me|help me understand)\b/i;
  private static readonly UNCERTAINTY =
    /\b(idk|i don't know|i dont know|not sure|unsure|confused|what's the difference|whats the difference|explain|understand|curious|wondering|clarify)\b/i;

  private isQuestionLike(text: string): boolean {
    const t = text.trim();
    return (
      t.includes("?") ||
      CopilotSessionService.QUESTION_WORDS.test(t) ||
      CopilotSessionService.UNCERTAINTY.test(t)
    );
  }

  /**
   * Heuristic: does this chat read like the developer exploring/asking
   * questions about a topic, rather than tracking concrete work? Looks for a
   * high ratio of question-shaped prompts and explicit uncertainty markers.
   */
  private isExploratory(texts: string[]): boolean {
    if (texts.length === 0) {
      return false;
    }
    let questionLike = 0;
    for (const t of texts) {
      if (this.isQuestionLike(t)) {
        questionLike++;
      }
    }
    // Mostly questions, or any explicit "I don't understand"-style prompt.
    return (
      questionLike / texts.length >= 0.5 ||
      texts.some((t) => CopilotSessionService.UNCERTAINTY.test(t))
    );
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
