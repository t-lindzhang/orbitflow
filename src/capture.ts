import * as vscode from "vscode";
import { ResumeContext } from "./types";

/**
 * Tracks recent terminal commands (via shell integration, when available)
 * and snapshots the current workspace context on demand.
 */
export class CaptureService implements vscode.Disposable {
  private readonly recentCommands: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private static readonly MAX_COMMANDS = 20;

  constructor() {
    // Shell integration API: available in recent VS Code versions.
    const anyWindow = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: vscode.Event<{
        execution: { commandLine?: { value?: string } };
      }>;
    };
    if (anyWindow.onDidStartTerminalShellExecution) {
      this.disposables.push(
        anyWindow.onDidStartTerminalShellExecution((e) => {
          const cmd = e.execution?.commandLine?.value?.trim();
          if (cmd) {
            this.pushCommand(cmd);
          }
        })
      );
    }
  }

  private pushCommand(cmd: string): void {
    this.recentCommands.push(cmd);
    while (this.recentCommands.length > CaptureService.MAX_COMMANDS) {
      this.recentCommands.shift();
    }
  }

  snapshot(): ResumeContext {
    const files: ResumeContext["files"] = [];
    const seen = new Set<string>();

    const active = vscode.window.activeTextEditor;
    const activePath = active?.document.uri.fsPath;

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText) {
          const p = input.uri.fsPath;
          if (seen.has(p)) {
            continue;
          }
          seen.add(p);
          files.push({
            path: p,
            active: p === activePath,
            line:
              p === activePath && active
                ? active.selection.active.line
                : undefined,
          });
        }
      }
    }

    return {
      files,
      terminalCommands: [...this.recentCommands],
    };
  }

  /** A short, human-readable label for the current context. */
  describe(): string {
    const active = vscode.window.activeTextEditor;
    if (active) {
      return vscode.workspace.asRelativePath(active.document.uri);
    }
    const first = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
    return first ?? "Workspace";
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
