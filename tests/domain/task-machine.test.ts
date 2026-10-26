import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import type { TaskState } from "../../src/domain/model.js";
import {
  assertTaskDependencyGraph,
  assertTaskTransition,
} from "../../src/domain/task-machine.js";

const states: TaskState[] = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "completed",
];

const legalTransitions = [
  ["draft", "ready"],
  ["ready", "in_progress"],
  ["in_progress", "blocked"],
  ["in_progress", "completed"],
  ["blocked", "ready"],
] as const;

describe("task state machine", () => {
  it.each(legalTransitions)("allows %s -> %s", (current, next) => {
    expect(() => assertTaskTransition(current, next)).not.toThrow();
  });

  it.each(
    states.flatMap((current) =>
      states
        .filter(
          (next) =>
            !legalTransitions.some(
              ([legalCurrent, legalNext]) =>
                legalCurrent === current && legalNext === next,
            ),
        )
        .map((next) => [current, next] as const),
    ),
  )("rejects illegal transition %s -> %s", (current, next) => {
    expect(() => assertTaskTransition(current, next)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "CONFLICT" }),
    );
  });
});

describe("task dependency graph", () => {
  it("accepts an acyclic workspace graph", () => {
    expect(() =>
      assertTaskDependencyGraph([
        { id: "task-a", dependencyIds: [] },
        { id: "task-b", dependencyIds: ["task-a"] },
        { id: "task-c", dependencyIds: ["task-a", "task-b"] },
      ]),
    ).not.toThrow();
  });

  it("rejects a self-dependency", () => {
    expect(() =>
      assertTaskDependencyGraph([{ id: "task-a", dependencyIds: ["task-a"] }]),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects a multi-node cycle", () => {
    expect(() =>
      assertTaskDependencyGraph([
        { id: "task-a", dependencyIds: ["task-c"] },
        { id: "task-b", dependencyIds: ["task-a"] },
        { id: "task-c", dependencyIds: ["task-b"] },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "CONFLICT" }),
    );
  });
});
