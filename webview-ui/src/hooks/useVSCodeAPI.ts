import { useState, useEffect, useCallback } from 'react';
import { FocusTreeState } from '../types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): FocusTreeState | undefined;
  setState(state: FocusTreeState): void;
};

const vscode = acquireVsCodeApi();

export function useVSCodeAPI() {
  // Restore from VS Code's webview state persistence
  const [state, setState] = useState<FocusTreeState | null>(
    vscode.getState() || null
  );

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'stateUpdate') {
        setState(message.state);
        // Persist so it survives webview hide/show
        vscode.setState(message.state);
      }
    };
    window.addEventListener('message', handler);

    // Request current state from extension on mount
    vscode.postMessage({ command: 'requestState' });

    return () => window.removeEventListener('message', handler);
  }, []);

  const sendMessage = useCallback((command: string, data?: Record<string, unknown>) => {
    vscode.postMessage({ command, ...data });
  }, []);

  return { state, sendMessage };
}
