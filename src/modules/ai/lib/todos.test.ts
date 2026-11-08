import { describe, expect, it } from "vitest";
import { type Todo, revertInProgressTodos, validateTodos } from "./todos";

function todo(over: Partial<Todo> = {}): Todo {
  return { id: "t1", title: "task", status: "pending", ...over };
}

describe("validateTodos", () => {
  it("accepts an empty list", () => {
    expect(validateTodos([])).toBeNull();
  });

  it("accepts a list with a single in_progress item", () => {
    expect(
      validateTodos([
        todo({ id: "a", status: "in_progress" }),
        todo({ id: "b", status: "pending" }),
      ]),
    ).toBeNull();
  });

  it("rejects an empty or whitespace title", () => {
    expect(validateTodos([todo({ title: "" })])).toContain("title");
    expect(validateTodos([todo({ title: "   " })])).toContain("title");
  });

  it("rejects more than one in_progress item", () => {
    const err = validateTodos([
      todo({ id: "a", status: "in_progress" }),
      todo({ id: "b", status: "in_progress" }),
    ]);
    expect(err).toContain("in_progress");
    expect(err).toContain("2");
  });
});

describe("revertInProgressTodos (Fase 9)", () => {
  it("drops in_progress back to pending and reports changed", () => {
    const { todos, changed } = revertInProgressTodos([
      todo({ id: "a", status: "in_progress" }),
      todo({ id: "b", status: "pending" }),
      todo({ id: "c", status: "completed" }),
    ]);
    expect(changed).toBe(true);
    expect(todos.map((t) => t.status)).toEqual([
      "pending",
      "pending",
      "completed",
    ]);
  });

  it("leaves a list without in_progress untouched and reports unchanged", () => {
    const input = [
      todo({ id: "a", status: "pending" }),
      todo({ id: "b", status: "completed" }),
    ];
    const { todos, changed } = revertInProgressTodos(input);
    expect(changed).toBe(false);
    expect(todos).toEqual(input);
  });

  it("does not mutate the input list", () => {
    const input = [todo({ id: "a", status: "in_progress" })];
    revertInProgressTodos(input);
    expect(input[0].status).toBe("in_progress");
  });
});
