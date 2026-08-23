// FORGE benchmark fixture (simple-crud): a deliberately tiny, healthy starting point.
// No CRUD routes exist yet — the benchmark queue asks FORGE to build them from scratch
// against a `tasks` table. This is a DISPOSABLE fixture; never a real project.

export function createApp() {
  const tasks = new Map();
  return {
    listTasks: () => Array.from(tasks.values()),
  };
}
