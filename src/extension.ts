import * as vscode from "vscode";
import { Storage } from "./storage";
import { CaptureService } from "./capture";
import { TreeViewProvider } from "./treeViewProvider";
import { AutoNodeService } from "./autoNode";
import { CopilotSessionService } from "./copilotSessions";
import { CommitCompletionService } from "./completion";

export function activate(context: vscode.ExtensionContext): void {
  const storage = new Storage(context.workspaceState);
  const capture = new CaptureService();
  const provider = new TreeViewProvider(context, storage, capture);

  void provider.autoBootstrap();

  const log = vscode.window.createOutputChannel("OrbitFlow", { log: true });
  const autoNodes = new AutoNodeService(
    (clusters) => provider.addAutoNodes(clusters),
    () => provider.getActiveTreeNodes(),
    log
  );

  const copilotSessions = new CopilotSessionService(
    context,
    (info) => provider.upsertSessionNode(info),
    log
  );
  void copilotSessions.start();

  const completion = new CommitCompletionService(
    () => provider.getOpenNodes(),
    (titles) => provider.markNodesDone(titles),
    log
  );
  void completion.start();

  context.subscriptions.push(
    capture,
    autoNodes,
    copilotSessions,
    completion,
    log,
    vscode.window.registerWebviewViewProvider(
      TreeViewProvider.viewType,
      provider
    ),
    vscode.window.registerWebviewViewProvider("orbitflow.listView", provider),
    vscode.commands.registerCommand("orbitflow.openGraph", () =>
      provider.openInEditor()
    ),
    vscode.commands.registerCommand("orbitflow.reorganize", () =>
      provider.reorganizeActiveTree()
    ),
    vscode.commands.registerCommand("orbitflow.revert", () =>
      provider.revert()
    ),
    vscode.commands.registerCommand("orbitflow.generateTrees", () =>
      provider.generateTrees()
    ),
    vscode.commands.registerCommand("orbitflow.clearAll", () =>
      provider.clearAll()
    )
  );
}

export function deactivate(): void {
  // no-op
}
