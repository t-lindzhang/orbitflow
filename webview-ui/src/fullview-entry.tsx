import React from 'react';
import ReactDOM from 'react-dom/client';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { WorkingTree } from './components/WorkingTree';
import { PriorityList } from './components/PriorityList';
import './styles/fullview.css';

function FullViewApp() {
  const { state, sendMessage, userTasks, saveUserTasks } = useVSCodeAPI();

  const handleSelectNode = (nodeId: string) => {
    sendMessage('selectNode', { nodeId });
  };

  const handleReveal = (nodeId: string) => {
    sendMessage('reveal', { nodeId });
  };

  const handleResume = (nodeId: string) => {
    sendMessage('resume', { nodeId });
  };

  const handlePrune = (nodeId: string) => {
    sendMessage('pruneSubtree', { nodeId });
  };

  const handleEditNode = (nodeId: string, title?: string, detail?: string) => {
    sendMessage('editNode', { nodeId, title, detail });
  };

  return (
    <div className="fullview-container">
      <div className="fullview-tree-panel">
        <div className="toolbar">
          <h2 className="panel-title">Focus Tree</h2>
          <div className="toolbar-actions">
            <button onClick={() => sendMessage('revert')} title="Revert to previous tree">↶</button>
            <button onClick={() => sendMessage('clearAll')} title="Clear memory trees">🗑</button>
          </div>
        </div>
        {state ? (
          <WorkingTree state={state} onSelectNode={handleSelectNode} onResumeNode={handleReveal} onPruneNode={handlePrune} />
        ) : (
          <div className="empty-state">Loading...</div>
        )}
      </div>

      <div className="fullview-divider" />

      <div className="fullview-checklist-panel">
        <h2 className="panel-title">Priorities</h2>
        <PriorityList state={state} onSelectNode={handleSelectNode} onResume={handleResume}
          savedTasks={userTasks} onTasksChange={saveUserTasks} />
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<FullViewApp />);
