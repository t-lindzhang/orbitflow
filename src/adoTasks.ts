import * as vscode from "vscode";

/** Work-item fields we map onto a task node. */
export interface AdoTaskInfo {
  /** Stable id for dedup/update: `ado:<workItemId>`. */
  sourceId: string;
  title: string;
  detail: string;
  /** High-priority work items (ADO priority 1) surface as urgent. */
  urgent: boolean;
  /** Item is in a terminal/closed state. */
  done: boolean;
  /** Parent work-item id (System.Parent), used to build subtrees. */
  parentId?: number;
}

/** A node's place in the ADO hierarchy, applied after all items are upserted. */
export interface AdoHierarchyLink {
  sourceId: string;
  parentSourceId?: string;
}

export type UpsertTask = (info: AdoTaskInfo) => Promise<void>;

/** A selectable work item in the "keep" picker. */
interface AdoPick extends vscode.QuickPickItem {
  info: AdoTaskInfo;
}

/** ADO work-item states that map to a "done" node. */
const DONE_STATES = new Set([
  "closed",
  "done",
  "resolved",
  "completed",
  "removed",
]);

/**
 * Pulls the developer's assigned Azure DevOps work items and surfaces each as
 * a task node. Authentication uses VS Code's built-in Microsoft auth provider
 * (no PAT), and org/project come from settings. Fails gracefully (no-op) when
 * unconfigured, signed out, or the API is unreachable.
 */
export class AdoTaskService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;

  /** Azure DevOps Entra resource id — the audience for the access token. */
  private static readonly ADO_RESOURCE =
    "499b84ac-1321-427f-aa17-267ca6975798";
  /** Work items change slowly; a long poll keeps the tree fresh cheaply. */
  private static readonly POLL_MS = 5 * 60 * 1000;
  /** Cap how many items we ever import in one sync. */
  private static readonly MAX_ITEMS = 50;
  /** workspaceState key holding the work-item ids the user chose to keep. */
  private static readonly KEPT_KEY = "orbitflow.ado.keptIds";

  constructor(
    private readonly upsert: UpsertTask,
    /** Remove ADO nodes whose `sourceId` is not in the kept set. */
    private readonly prune: (keepSourceIds: string[]) => Promise<void>,
    /** Re-parent kept ADO nodes to mirror the work-item hierarchy. */
    private readonly applyHierarchy: (links: AdoHierarchyLink[]) => Promise<void>,
    private readonly memento: vscode.Memento,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async start(): Promise<void> {
    // Opt-in: do nothing until the user enables the integration.
    if (!this.config()) {
      this.log.debug("ADO: integration disabled or not configured; skipping.");
      // Still watch for the user enabling it later.
      this.disposables.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration("orbitflow.ado")) {
            void this.onConfigChanged();
          }
        })
      );
      return;
    }
    this.startPolling();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("orbitflow.ado")) {
          void this.onConfigChanged();
        }
      })
    );
  }

  /** Begin background refresh of the user's chosen items (idempotent). */
  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    void this.sync(false);
    this.pollTimer = setInterval(
      () => void this.sync(false),
      AdoTaskService.POLL_MS
    );
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          void this.sync(false);
        }
      })
    );
  }

  /** React to the user toggling the integration on/off at runtime. */
  private async onConfigChanged(): Promise<void> {
    if (this.config()) {
      this.startPolling();
    } else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Sync ADO work items. Interactive syncs let the user pick which assigned
   * items to keep (and prune the rest); the polled path silently refreshes
   * only the already-kept items, never importing new ones on its own.
   */
  async sync(interactive: boolean): Promise<void> {
    // Opt-in. The polled path stays silent when disabled; an interactive sync
    // (the cloud button / command) offers to turn the integration on so the
    // button is the single entry point — no Settings detour.
    if (!this.isEnabled()) {
      if (!interactive) {
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        "Enable Azure DevOps task sync? OrbitFlow will import your assigned work items as task nodes.",
        "Enable"
      );
      if (choice !== "Enable") {
        return;
      }
      await vscode.workspace
        .getConfiguration("orbitflow")
        .update("ado.enabled", true, vscode.ConfigurationTarget.Global);
      this.startPolling();
    }

    const cfg = this.rawConfig();
    if (!cfg) {
      if (interactive) {
        void vscode.window.showWarningMessage(
          "OrbitFlow: set orbitflow.ado.org and orbitflow.ado.project to sync ADO tasks."
        );
      }
      return;
    }

    const token = await this.token(interactive);
    if (!token) {
      if (interactive) {
        void vscode.window.showWarningMessage(
          "OrbitFlow: sign in to Azure DevOps to sync tasks."
        );
      }
      return;
    }

    try {
      if (interactive) {
        await this.syncInteractive(cfg, token);
      } else {
        await this.syncKept(cfg, token);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`ADO sync failed: ${msg}`);
      if (interactive) {
        void vscode.window.showErrorMessage(
          `OrbitFlow: ADO sync failed — ${msg}`
        );
      }
    }
  }

  /** Let the user choose which assigned items to keep, then apply the choice. */
  private async syncInteractive(
    cfg: { org: string; project: string },
    token: string
  ): Promise<void> {
    const ids = await this.queryAssignedIds(cfg, token);
    if (ids.length === 0) {
      vscode.window.setStatusBarMessage(
        "$(cloud) OrbitFlow: no ADO tasks assigned",
        4000
      );
      return;
    }
    const items = await this.fetchItems(cfg, token, ids);
    const kept = new Set(this.keptIds());
    const picks = await vscode.window.showQuickPick<AdoPick>(
      items.map((info) => ({
        label: info.title,
        description: `#${idOf(info)}`,
        detail: info.detail,
        picked: kept.has(idOf(info)),
        info,
      })),
      {
        canPickMany: true,
        title: "Select Azure DevOps work items to keep in OrbitFlow",
        placeHolder: "Checked items become task nodes; unchecked ones are removed",
        matchOnDetail: true,
      }
    );
    if (!picks) {
      return; // cancelled — leave current state untouched
    }
    const chosen = picks.map((p) => p.info);
    await this.setKeptIds(chosen.map(idOf));
    await this.prune(chosen.map((c) => c.sourceId));
    for (const info of chosen) {
      await this.upsert(info);
    }
    await this.applyHierarchy(hierarchyOf(chosen));
    this.log.info(`ADO: kept ${chosen.length} of ${items.length} item(s).`);
    vscode.window.setStatusBarMessage(
      `$(cloud-download) OrbitFlow: keeping ${chosen.length} ADO task(s)`,
      4000
    );
  }

  /** Background refresh: update only the items the user previously kept. */
  private async syncKept(
    cfg: { org: string; project: string },
    token: string
  ): Promise<void> {
    const kept = new Set(this.keptIds());
    if (kept.size === 0) {
      return; // nothing chosen yet; selection is user-driven
    }
    const assigned = new Set(await this.queryAssignedIds(cfg, token));
    const refresh = [...kept].filter((id) => assigned.has(id));
    if (refresh.length === 0) {
      return;
    }
    const items = await this.fetchItems(cfg, token, refresh);
    for (const info of items) {
      await this.upsert(info);
    }
    await this.applyHierarchy(hierarchyOf(items));
    this.log.info(`ADO: refreshed ${items.length} kept item(s).`);
  }

  private keptIds(): number[] {
    return this.memento.get<number[]>(AdoTaskService.KEPT_KEY, []);
  }

  private async setKeptIds(ids: number[]): Promise<void> {
    await this.memento.update(AdoTaskService.KEPT_KEY, ids);
  }

  /** Run the WIQL query for the user's open, assigned work items. */
  private async queryAssignedIds(
    cfg: { org: string; project: string },
    token: string
  ): Promise<number[]> {
    const project = cfg.project.replace(/'/g, "''");
    const wiql = [
      "SELECT [System.Id] FROM WorkItems",
      `WHERE [System.TeamProject] = '${project}'`,
      "AND [System.AssignedTo] = @Me",
      "AND [System.State] <> 'Closed'",
      "AND [System.State] <> 'Removed'",
      "ORDER BY [System.ChangedDate] DESC",
    ].join(" ");
    const url = `https://dev.azure.com/${cfg.org}/${encodeURIComponent(
      cfg.project
    )}/_apis/wit/wiql?api-version=7.0`;
    const data = (await this.fetchJson(url, token, { query: wiql })) as {
      workItems?: { id: number }[];
    };
    return (data.workItems ?? [])
      .map((w) => w.id)
      .slice(0, AdoTaskService.MAX_ITEMS);
  }

  /** Batch-fetch the fields we need and map each item to a task. */
  private async fetchItems(
    cfg: { org: string; project: string },
    token: string,
    ids: number[]
  ): Promise<AdoTaskInfo[]> {
    const url = `https://dev.azure.com/${cfg.org}/_apis/wit/workitemsbatch?api-version=7.0`;
    const data = (await this.fetchJson(url, token, {
      ids,
      fields: [
        "System.Id",
        "System.Title",
        "System.State",
        "System.WorkItemType",
        "System.Description",
        "System.Parent",
        "Microsoft.VSTS.Common.Priority",
      ],
    })) as { value?: { id?: number; fields?: Record<string, unknown> }[] };

    return (data.value ?? []).map((item) => {
      const f = item.fields ?? {};
      const id = (f["System.Id"] as number) ?? item.id;
      const title = String(f["System.Title"] ?? `Work item ${id}`);
      const state = String(f["System.State"] ?? "");
      const type = String(f["System.WorkItemType"] ?? "Task");
      const priority = Number(f["Microsoft.VSTS.Common.Priority"] ?? 4);
      const description = this.plain(String(f["System.Description"] ?? ""));
      const detail = description
        ? `[${type} · ${state}] ${truncate(description, 280)}`
        : `${type} · ${state}`;
      const parentRaw = f["System.Parent"];
      const parentId =
        typeof parentRaw === "number" && parentRaw > 0 ? parentRaw : undefined;
      return {
        sourceId: `ado:${id}`,
        title,
        detail,
        urgent: priority <= 1,
        done: DONE_STATES.has(state.toLowerCase()),
        parentId,
      };
    });
  }

  /** Acquire an Azure DevOps access token via the Microsoft auth provider. */
  private async token(interactive: boolean): Promise<string | undefined> {
    try {
      const session = await vscode.authentication.getSession(
        "microsoft",
        [`${AdoTaskService.ADO_RESOURCE}/.default`],
        interactive ? { createIfNone: true } : { silent: true }
      );
      return session?.accessToken;
    } catch (e) {
      this.log.debug(
        `ADO auth: ${e instanceof Error ? e.message : String(e)}`
      );
      return undefined;
    }
  }

  private async fetchJson(
    url: string,
    token: string,
    body: unknown
  ): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /** Whether the user has opted in to ADO sync. */
  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("orbitflow")
      .get<boolean>("ado.enabled", false);
  }

  /** Enabled org/project config, or undefined when opted out / unconfigured. */
  private config(): { org: string; project: string } | undefined {
    return this.isEnabled() ? this.rawConfig() : undefined;
  }

  /** Read and normalize org/project settings, ignoring the enabled flag. */
  private rawConfig(): { org: string; project: string } | undefined {
    const cfg = vscode.workspace.getConfiguration("orbitflow");
    let org = (cfg.get<string>("ado.org") ?? "").trim();
    const project = (cfg.get<string>("ado.project") ?? "").trim();
    if (!org || !project) {
      return undefined;
    }
    const vs = org.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
    const az = org.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
    if (vs) {
      org = vs[1];
    } else if (az) {
      org = az[1];
    }
    return { org, project };
  }

  /** Crude HTML -> text for work-item descriptions (which are HTML). */
  private plain(html: string): string {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Numeric work-item id from an `ado:<id>` sourceId. */
function idOf(info: AdoTaskInfo): number {
  return Number(info.sourceId.replace(/^ado:/, ""));
}

/** Build hierarchy links from items' System.Parent ids. */
function hierarchyOf(items: AdoTaskInfo[]): AdoHierarchyLink[] {
  return items.map((info) => ({
    sourceId: info.sourceId,
    parentSourceId: info.parentId ? `ado:${info.parentId}` : undefined,
  }));
}
