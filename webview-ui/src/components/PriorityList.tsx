import React, { useState } from 'react';
import { FocusTreeState, PriorityItem } from '../types';

interface PriorityListProps {
  state: FocusTreeState | null;
  onSelectNode: (nodeId: string) => void;
  onResume: (nodeId: string) => void;
  compact?: boolean;
  /** Add a user task (creates a synced task node in the tree). */
  onAddTask: (text: string) => void;
  /** Toggle a task node done/open. */
  onToggleTask: (nodeId: string) => void;
  /** Delete a task node. */
  onDeleteTask: (nodeId: string) => void;
}

export function PriorityList({ state, onSelectNode, onResume, compact = false, onAddTask, onToggleTask, onDeleteTask }: PriorityListProps) {
  const [newItem, setNewItem] = useState('');

  const addItem = () => {
    const text = newItem.trim();
    if (!text) return;
    onAddTask(text);
    setNewItem('');
  };

  // System-computed priority items from OrbitFlow
  const priorityItems = state?.priority || [];

  // User-added tasks are now first-class task nodes, identified by a `user:`
  // source. Derive them from the synced tree state so checking/deleting here
  // stays in lockstep with the tree view.
  const userTasks = Object.values(state?.tasks || {}).filter(
    (t) => t.sourceId?.startsWith('user:')
  );

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
      {userTasks.length > 0 && (
        <div className="priority-section">
          <div className="priority-section-label">My Tasks</div>
          {userTasks.map(task => (
            <div key={task.id} className={`priority-item user ${task.done ? 'done' : ''}`}>
              <input
                type="checkbox"
                checked={!!task.done}
                onChange={() => onToggleTask(task.id)}
              />
              <span className="priority-name" onClick={() => onSelectNode(task.id)}>{task.name}</span>
              {!compact && (
                <button className="delete-btn" onClick={() => onDeleteTask(task.id)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {priorityItems.length === 0 && userTasks.length === 0 && (
        <div className="priority-empty">
          No priority items yet. Tasks will appear here as you work.
        </div>
      )}
    </div>
  );
}
