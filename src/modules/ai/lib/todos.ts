import { LazyStore } from "@tauri-apps/plugin-store";

type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
};

const STORE_PATH = "terax-ai-todos.json";
const todosKey = (sessionId: string) => `todos:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadTodos(sessionId: string): Promise<Todo[]> {
  return (await store.get<Todo[]>(todosKey(sessionId))) ?? [];
}

export async function saveTodos(
  sessionId: string,
  todos: Todo[],
): Promise<void> {
  await store.set(todosKey(sessionId), todos);
}

export async function deleteTodos(sessionId: string): Promise<void> {
  await store.delete(todosKey(sessionId));
}

export function newTodoId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validate a candidate todo list:
 *  - At most one item with status `in_progress` (anti-drift invariant).
 *  - Titles must be non-empty.
 * Returns null on valid, otherwise an error string.
 */
export function validateTodos(todos: Todo[]): string | null {
  let inProgress = 0;
  for (const t of todos) {
    if (!t.title.trim()) return "todo title cannot be empty";
    if (t.status === "in_progress") inProgress++;
  }
  if (inProgress > 1)
    return `only one todo may be in_progress at a time (got ${inProgress})`;
  return null;
}

/**
 * Fase 9: a run that ends abnormally (stopped, interrupted, error) is no
 * longer working on anything, so a todo left `in_progress` by it is a
 * lie — the TodoStrip spinner would spin forever with no run behind it.
 * Drop such items back to `pending`: the work is still open, just not
 * currently being done. `completed` and `pending` items are untouched.
 * Returns the list plus whether anything changed, so callers only persist
 * when there is something to save.
 */
export function revertInProgressTodos(todos: Todo[]): {
  todos: Todo[];
  changed: boolean;
} {
  let changed = false;
  const next = todos.map((t) => {
    if (t.status !== "in_progress") return t;
    changed = true;
    return { ...t, status: "pending" as const };
  });
  return { todos: next, changed };
}
