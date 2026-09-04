import { describe, expect, test } from "bun:test";
import { cleanTitle, firstCompletedExchange } from "../../extensions/title/title.js";

describe("title generation inputs", () => {
  test("extracts the first completed user and assistant exchange", () => {
    const exchange = firstCompletedExchange([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Build titles" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implemented it" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Thanks" }] } },
    ]);

    expect(exchange).toEqual({ user: "Build titles", assistant: "Implemented it" });
  });

  test("requires assistant output", () => {
    expect(
      firstCompletedExchange([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Build titles" }] } },
      ]),
    ).toBeUndefined();
  });

  test("skips an incomplete exchange", () => {
    expect(
      firstCompletedExchange([
        { type: "message", message: { role: "user", content: "First request" } },
        { type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
        { type: "message", message: { role: "user", content: "Second request" } },
        { type: "message", message: { role: "assistant", content: "Completed response" } },
      ]),
    ).toEqual({ user: "Second request", assistant: "Completed response" });
  });
});

describe("title cleanup", () => {
  test("keeps only a clean first line", () => {
    expect(cleanTitle('Title: "Configure Pi Titles."\nExplanation', 60)).toBe("Configure Pi Titles");
  });

  test("enforces the configured length", () => {
    expect(cleanTitle("A deliberately long generated title", 12)).toBe("A deliberate");
  });
});
