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

/**
 * Best-effort: open the Copilot chat session a node was derived from.
 * `sourceId` has the form `chat:<sessionId>.jsonl`. Local chat sessions are
 * addressable as editors via the `vscode-chat-session` scheme, so we rebuild
 * that resource (mirroring VS Code's `LocalChatSessionUri.forSession`) and open
 * it. Falls back to focusing the chat surface when the specific session can't
 * be opened. Returns true when a chat surface was shown.
 */
export async function revealChatSession(sourceId: string): Promise<boolean> {
  const sessionId = sourceId
    .replace(/^chat:/, "")
    .replace(/\.jsonl$/i, "");

  // vscode-chat-session://local/<base64url(sessionId)>
  const encodedId = Buffer.from(sessionId, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sessionUri = vscode.Uri.from({
    scheme: "vscode-chat-session",
    authority: "local",
    path: "/" + encodedId,
  });
  try {
    await vscode.commands.executeCommand("vscode.open", sessionUri);
    return true;
  } catch {
    /* fall through to focusing the chat surface */
  }

  // Otherwise just reveal the chat surface so the thread can be picked up.
  const available = new Set(await vscode.commands.getCommands(true));
  const focusCandidates = [
    "workbench.panel.chat.view.copilot.focus",
    "workbench.action.chat.open",
    "workbench.action.openChat",
    "workbench.panel.chat.view.focus",
  ];
  for (const id of focusCandidates) {
    if (available.has(id)) {
      try {
        await vscode.commands.executeCommand(id);
        return true;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return false;
}
