import React from 'react';
import ReactDOM from 'react-dom/client';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { CompactTree } from './components/CompactTree';
import { Checklist } from './components/Checklist';
import './styles/sidebar.css';

function SidebarApp() {
  const { state, sendMessage } = useVSCodeAPI();

  const handleSelectNode = (nodeId: string) => {
    sendMessage('selectNode', { nodeId });
  };

  const handleOpenFullView = () => {
    sendMessage('openFullView');
  };

  return (
    <div className="sidebar-container">
      <div className="sidebar-section">
        <h3 className="section-title">🌳 Focus Tree</h3>
        {state && state.rootNodeId ? (
          <CompactTree state={state} onSelectNode={handleSelectNode} />
        ) : (
          <div className="empty-state">
            Open a file to start building your focus tree...
          </div>
        )}
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-section">
        <h3 className="section-title">☐ Checklist</h3>
        <Checklist compact />
      </div>

      <button className="expand-btn" onClick={handleOpenFullView}>
        ⤢ Open Full View
      </button>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<SidebarApp />);
