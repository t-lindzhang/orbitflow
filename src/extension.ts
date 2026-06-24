import * as vscode from "vscode";
import { Storage } from "./storage";
import { CaptureService } from "./capture";
import { TreeViewProvider } from "./treeViewProvider";
import { AutoNodeService } from "./autoNode";

export function activate(context: vscode.ExtensionContext): void {
  const storage = new Storage(context.workspaceState);
  const capture = new CaptureService();
  const provider = new TreeViewProvider(context, storage, capture);

  void provider.autoBootstrap();

  const autoNodes = new AutoNodeService((clusters) =>
    provider.addAutoNodes(clusters)
  );

  context.subscriptions.push(
    capture,
    autoNodes,
    vscode.window.registerWebviewViewProvider(
      TreeViewProvider.viewType,
      provider
    ),
    vscode.commands.registerCommand("orbitflow.captureNode", () =>
      provider.captureNode()
    ),
    vscode.commands.registerCommand("orbitflow.newTree", () =>
      provider.newTree()
    ),
    vscode.commands.registerCommand("orbitflow.clearAll", () =>
      provider.clearAll()
    )
  );
}

export function deactivate(): void {
  // no-op
}
