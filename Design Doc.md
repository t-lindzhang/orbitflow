# OrbitFlow — Design Doc

> A VS Code extension that helps developers with ADHD manage their workflow and focus on the right tasks.

## Overview

**High level:** A cognitive continuity assistant that helps neurodivergent knowledge workers maintain task context, recover unfinished work, and resume productive flow after interruptions.

| | |
|---|---|
| **Inspirations** | GitLens (VS Code native extension with git/agent-based workflow management), Obsidian (interactive knowledge graph), Todoist (make planning as easy as possible for the user) |
| **Target Audience** | Developers with neurodivergence |
| **Environment** | VS Code extension (with UI) with the ability to manage workspace view (e.g. open tabs, current file/line), terminal, and Copilot sessions |
| **End State** | The system automatically creates a memory tree of a user's work and helps them resume work with minimal cognitive overhead. |

### Key Features

- Create new trees based on an overarching project.
- Automatically create new nodes based on code change context and Copilot session context.
- Context-switch easily by resuming a node.
- Edit / prune / merge subtrees.
- Organize Copilot sessions by detecting when to switch to a new session, merging sessions & contexts, and flagging sessions that need review/interaction or have been completed.

### Philosophy

- User interaction should be minimal. The aim is simplify the workflow process for users by intelligently detecting modular checkpoints in their thought process, not ask the user to create their own worktrees. User editing ability should be there, but the user is expected to only use it when they're unsatisfied with the auto-generated worktrees and nodes.
- The UX should be as minimal as possible. The UI should be more iconic and memorable for demo-ing purposes.   

## Memory Tree

**Purpose:** Track previous ideas/sessions (interactive nodes) to organize and keep track of unfinished trains of thought.

**Structure:**

- A distinct tree for each independent task (e.g. different repos, Copilot sessions unrelated to existing work).
- Each tree has a different base color (randomly selected, off some color scheme, etc.).
- A "+" button below leaves provides the user a tree editing option.

## Thought Node

A unit of a train of thought — a research question, a step in a task, a new idea the user is exploring, etc.

**When to create a node:**

- When changes in the working area can be clustered into distinct task(s) based on the semantics of code changes.
- When a user explicitly uses "+".

**Appearance:**

- A node is color-coded based off the base color and how relevant the node is.
  - Likely, the deeper down a tree, the less relevant nodes are — but this might not always be the case. Use semantic relevance first.
  - **UI:** the edge can be gray or a de-saturated blend of adjacent node colors.
- A node is shaped based on node type:
  - **Dot** — an actionable step in a task.
  - **Square** — a distinct thread in a Copilot session.
  - **Triangle** — a new idea.
- Add exclamation marks / concentric circles / some other visual marker for urgent nodes (e.g. completed Copilot sessions the user should check in on, tasks with an attached deadline).

### Interactions

**Always display:**

- A brief title of the node subtask/question/idea (< 5 words).
- Date/time last active.

**Hover:**

- Display detailed task information, name of session or prompt, etc.
- Edit options — resume into node / delete node / etc.

**Click:**

- Make the hover info card permanent/sticky.

**Click "Resume":**

- Open the right file that you were working on.
- If a specific line can be identified, jump to that line.
- Open relevant file tabs in VS Code.
- Restore terminal history in VS Code.
- Open the right Copilot session.

## List / Priority List

Another more linear/consolidated/less distracting view based on what needs attention at the moment.

- Pick nodes from trees based on priority — the list view should **not** be a 1-1 remap of the tree view.
- Surfaces:
  - Agent sessions needing follow-up.
  - Work trees/tasks that have been abandoned or forgotten but remain important.
  - Uncommitted code changes.
- Prioritized nodes should be highlighted in the tree (see [Thought Node](#thought-node)).

## Copilot Session Management

- Suggest starting a new session when a user asks a completely unrelated question in an existing session.
- Suggest merging sessions and their contexts when a user starts a new session that should be a continuation of an existing session.
- Be able to retro-actively split/merge existing messy sessions using checkpoints.
- Distinct investigation paths within sessions should be automatically turned into nodes.
  - Sessions with user requests should definitely be nodes.
  - Need to detect when a research-based session should become an idea/question node.
