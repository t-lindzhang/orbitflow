import * as vscode from "vscode";
import { ResumeContext } from "./types";

/** Reconstructs a saved workspace context: opens files/tabs and jumps to line. */
export async function resumeContext(ctx: ResumeContext): Promise<void> {
  const inactive = ctx.files.filter((f) => !f.active);
  const active = ctx.files.find((f) => f.active);

  for (const file of inactive) {
    await openFile(file.path, undefined, false);
  }

  if (active) {
    await openFile(active.path, active.line, true);
  } else if (ctx.files.length > 0) {
    await openFile(ctx.files[0].path, ctx.files[0].line, true);
  }

  if (ctx.terminalCommands.length > 0) {
    const terminal =
      vscode.window.activeTerminal ??
      vscode.window.createTerminal("OrbitFlow Resume");
    terminal.show();
    // Surface prior commands without auto-executing them.
    const last = ctx.terminalCommands[ctx.terminalCommands.length - 1];
    terminal.sendText(`# OrbitFlow restored — last command was: ${last}`, false);
  }
}

async function openFile(
  fsPath: string,
  line: number | undefined,
  focus: boolean
): Promise<void> {
  try {
    const uri = vscode.Uri.file(fsPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: !focus,
    });
    if (line !== undefined && focus) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    }
  } catch {
    vscode.window.showWarningMessage(
      `OrbitFlow: could not reopen ${fsPath}`
    );
  }
}
