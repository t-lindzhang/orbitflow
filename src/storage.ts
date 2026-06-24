import * as vscode from "vscode";
import { OrbitState } from "./types";

const STATE_KEY = "orbitflow.state.v1";

const EMPTY_STATE: OrbitState = {
  trees: [],
  nodes: [],
  activeNodeId: null,
  activeTreeId: null,
};

export class Storage {
  constructor(private readonly memento: vscode.Memento) {}

  load(): OrbitState {
    const stored = this.memento.get<OrbitState>(STATE_KEY);
    if (!stored) {
      return structuredClone(EMPTY_STATE);
    }
    return {
      ...structuredClone(EMPTY_STATE),
      ...stored,
    };
  }

  async save(state: OrbitState): Promise<void> {
    await this.memento.update(STATE_KEY, state);
  }

  async clear(): Promise<void> {
    await this.memento.update(STATE_KEY, structuredClone(EMPTY_STATE));
  }
}
