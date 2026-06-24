import React from 'react';
import ReactDOM from 'react-dom/client';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { WorkingTree } from './components/WorkingTree';
import { Checklist } from './components/Checklist';
import './styles/fullview.css';

function FullViewApp() {
  const { state, sendMessage } = useVSCodeAPI();

  const handleSelectNode = (nodeId: string) => {
    sendMessage('selectNode', { nodeId });
  };

  return (
    <div className="fullview-container">
      <div className="fullview-tree-panel">
        <h2 className="panel-title">Working Tree</h2>
        {state ? (
          <WorkingTree state={state} onSelectNode={handleSelectNode} />
        ) : (
          <div className="empty-state">Loading...</div>
        )}
      </div>

      <div className="fullview-divider" />

      <div className="fullview-checklist-panel">
        <h2 className="panel-title">Checklist</h2>
        <Checklist />
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<FullViewApp />);
