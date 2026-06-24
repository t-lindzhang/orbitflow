import React, { useState } from 'react';

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

interface ChecklistProps {
  compact?: boolean;
}

export function Checklist({ compact = false }: ChecklistProps) {
  const [items, setItems] = useState<ChecklistItem[]>([
    { id: '1', text: 'Example task', done: false },
  ]);
  const [newItem, setNewItem] = useState('');

  const addItem = () => {
    if (!newItem.trim()) return;
    setItems([...items, { id: Date.now().toString(), text: newItem.trim(), done: false }]);
    setNewItem('');
  };

  const toggleItem = (id: string) => {
    setItems(items.map(item =>
      item.id === id ? { ...item, done: !item.done } : item
    ));
  };

  const deleteItem = (id: string) => {
    setItems(items.filter(item => item.id !== id));
  };

  return (
    <div className={`checklist ${compact ? 'compact' : ''}`}>
      <div className="checklist-input">
        <input
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
          placeholder="Add a task..."
        />
        <button onClick={addItem}>+</button>
      </div>
      <ul className="checklist-items">
        {items.map(item => (
          <li key={item.id} className={item.done ? 'done' : ''}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => toggleItem(item.id)}
            />
            <span className="item-text">{item.text}</span>
            {!compact && (
              <button className="delete-btn" onClick={() => deleteItem(item.id)}>×</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
