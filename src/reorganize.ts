import * as vscode from "vscode";

export interface ReorgNode {
  title: string;
  detail: string;
}

export interface ParentLink {
  title: string;
  parent: string;
}

/**
 * Ask the LM to reorganize a flat-ish set of existing nodes into a sensible
 * hierarchy, grouping related subtasks under broader ones.
 */
export async function proposeHierarchy(
  nodes: ReorgNode[]
): Promise<ParentLink[]> {
  try {
    const [model] = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (!model) {
      return [];
    }

    const list = nodes
      .map((n) => `- ${n.title}${n.detail ? ` — ${n.detail}` : ""}`)
      .join("\n");

    const prompt = [
      "You reorganize a developer's thought nodes into a clean hierarchy.",
      "Group related subtasks UNDER the broader task they belong to, forming",
      "subtrees. Keep the structure meaningful — do not over-nest.",
      "",
      "Return ONLY a JSON array, no prose. One item per node:",
      '{ "title": string (exact, unchanged), "parent": string }',
      'Set "parent" to the EXACT title of another node it belongs under,',
      'or "ROOT" if it is a top-level task.',
      "Every title from the list must appear exactly once. Do not invent",
      "titles or create cycles.",
      "",
      "Nodes:",
      list,
    ].join("\n");

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
    return parseLinks(text);
  } catch {
    return [];
  }
}

function parseLinks(raw: string): ParentLink[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    return parsed
      .map((item) => item as Partial<ParentLink>)
      .filter(
        (item): item is ParentLink =>
          typeof item.title === "string" &&
          item.title.trim().length > 0 &&
          typeof item.parent === "string" &&
          item.parent.trim().length > 0
      )
      .map((item) => ({
        title: item.title.trim(),
        parent: item.parent.trim(),
      }));
  } catch {
    return [];
  }
}
