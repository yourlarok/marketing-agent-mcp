import { DomainError } from "./errors.js";
import { TASK_STATES, type TaskState } from "./model.js";

const transitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["ready"],
  ready: ["in_progress"],
  in_progress: ["blocked", "completed"],
  blocked: ["ready"],
  completed: [],
};

export function assertTaskTransition(current: TaskState, next: TaskState): void {
  if (
    !(TASK_STATES as readonly string[]).includes(current) ||
    !(TASK_STATES as readonly string[]).includes(next)
  ) {
    throw new DomainError("INVALID_INPUT", "Task state must be supported");
  }
  if (!transitions[current].includes(next)) {
    throw new DomainError(
      "CONFLICT",
      `Task cannot transition from ${current} to ${next}`,
      false,
      { current, next },
    );
  }
}

export interface TaskDependencyNode {
  id: string;
  dependencyIds: readonly string[];
}

export function assertTaskDependencyGraph(
  tasks: Iterable<TaskDependencyNode>,
): void {
  const graph = new Map<string, readonly string[]>();
  for (const task of tasks) {
    graph.set(task.id, task.dependencyIds);
  }
  for (const [id, dependencyIds] of graph) {
    if (dependencyIds.includes(id)) {
      throw new DomainError(
        "INVALID_INPUT",
        "A task cannot depend on itself",
        false,
        { taskId: id },
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new DomainError(
        "CONFLICT",
        "Task dependencies must not contain cycles",
        false,
        { taskId: id },
      );
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependencyId of graph.get(id) ?? []) {
      if (graph.has(dependencyId)) {
        visit(dependencyId);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) {
    visit(id);
  }
}
