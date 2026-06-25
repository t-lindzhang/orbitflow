import React from 'react';
import ReactDOM from 'react-dom/client';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { CompactTree } from './components/CompactTree';
import { PriorityList } from './components/PriorityList';
import './styles/sidebar.css';

function SidebarApp() {
  const { state, sendMessage } = useVSCodeAPI();

  const handleReveal = (nodeId: string) => {
    sendMessage('reveal', { nodeId });
  };

  const handleResume = (nodeId: string) => {
    sendMessage('resume', { nodeId });
  };

  const handleOpenFullView = () => {
    sendMessage('openFullView');
  };

  const handleAddTask = (text: string) => {
    sendMessage('addUserTask', { text });
  };

  return (
    <div className="sidebar-container">
      <div className="sidebar-section">
        <div className="section-header">
          <h3 className="section-title">Focus Tree</h3>
          <button className="section-action" onClick={() => sendMessage('syncAdo')}
            title="Sync Azure DevOps tasks">☁︎ ADO</button>
        </div>
        {state && state.rootNodeId ? (
          <CompactTree state={state} onSelectNode={handleResume} />
        ) : (
          <div className="empty-state">
            Open a file to start building your focus tree...
          </div>
        )}
        <div className="legend-compact">
          <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg> Task</span>
          <span><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg> Session</span>
          <span><svg width="10" height="10"><polygon points="5,1 1,9 9,9" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg> Idea</span>
        </div>
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-section">
        <h3 className="section-title">Priorities</h3>
        <PriorityList state={state} onSelectNode={handleReveal} onResume={handleResume} compact
          onAddTask={handleAddTask} />
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<SidebarApp />);
