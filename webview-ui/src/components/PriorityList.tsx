import React, { useState } from 'react';
import { FocusTreeState, PriorityItem } from '../types';

interface PriorityListProps {
  state: FocusTreeState | null;
  onSelectNode: (nodeId: string) => void;
  onResume: (nodeId: string) => void;
  compact?: boolean;
  /** Add a user task (creates a synced task node in the tree). */
  onAddTask: (text: string) => void;
}

export function PriorityList({ state, onSelectNode, onResume, compact = false, onAddTask }: PriorityListProps) {
  const [newItem, setNewItem] = useState('');

  const addItem = () => {
    const text = newItem.trim();
    if (!text) return;
    onAddTask(text);
    setNewItem('');
  };

  // System-computed priority items from OrbitFlow
  const priorityItems = state?.priority || [];

  return (
    <div className={`priority-list ${compact ? 'compact' : ''}`}>
      {/* Manual task input */}
      <div className="priority-input">
        <input
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
          placeholder="Add a task..."
        />
        <button onClick={addItem}>+</button>
      </div>

      {/* System priority items (from OrbitFlow's computePriority) */}
      {priorityItems.length > 0 && (
        <div className="priority-section">
          <div className="priority-section-label">Needs Attention</div>
          {priorityItems.map((item) => {
            const task = state?.tasks[item.id];
            if (!task) return null;
            const needsAttention = !!task.waiting;
            return (
              <div key={item.id} className={`priority-item system ${needsAttention ? 'needs-attention' : ''}`}
                onClick={() => onSelectNode(item.id)}>
                <span className={`priority-dot ${task.nodeType || 'task'}`} />
                <div className="priority-content">
                  <span className="priority-name">{task.name}</span>
                  <span className="priority-reason">{item.reason}</span>
                </div>
                {!compact && (
                  <button className="resume-btn" onClick={(e) => { e.stopPropagation(); onResume(item.id); }}>
                    ▶
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* User-added tasks (synced task nodes) */}
      {priorityItems.length === 0 && (
        <div className="priority-empty">
          No priority items yet. Tasks will appear here as you work.
        </div>
      )}
    </div>
  );
}
