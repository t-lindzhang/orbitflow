import React, { useState } from 'react';
import { FocusTreeState, PriorityItem } from '../types';

interface PriorityListProps {
  state: FocusTreeState | null;
  onSelectNode: (nodeId: string) => void;
  onResume: (nodeId: string) => void;
  compact?: boolean;
}

export function PriorityList({ state, onSelectNode, onResume, compact = false }: PriorityListProps) {
  const [newItem, setNewItem] = useState('');
  const [userItems, setUserItems] = useState<{ id: string; text: string; done: boolean }[]>([]);

  const addItem = () => {
    if (!newItem.trim()) return;
    setUserItems([...userItems, { id: Date.now().toString(), text: newItem.trim(), done: false }]);
    setNewItem('');
  };

  const toggleItem = (id: string) => {
    setUserItems(userItems.map(item =>
      item.id === id ? { ...item, done: !item.done } : item
    ));
  };

  const deleteItem = (id: string) => {
    setUserItems(userItems.filter(item => item.id !== id));
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

      {/* User-added tasks */}
      {userItems.length > 0 && (
        <div className="priority-section">
          <div className="priority-section-label">My Tasks</div>
          {userItems.map(item => (
            <div key={item.id} className={`priority-item user ${item.done ? 'done' : ''}`}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => toggleItem(item.id)}
              />
              <span className="priority-name">{item.text}</span>
              {!compact && (
                <button className="delete-btn" onClick={() => deleteItem(item.id)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {priorityItems.length === 0 && userItems.length === 0 && (
        <div className="priority-empty">
          No priority items yet. Tasks will appear here as you work.
        </div>
      )}
    </div>
  );
}
