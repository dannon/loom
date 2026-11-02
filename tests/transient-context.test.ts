import { describe, expect, it } from "vitest";
import { insertBeforeLastUser } from "../extensions/orbit/transient-context";

describe("insertBeforeLastUser", () => {
  const roles = (ms: { role: string }[]) => ms.map((m) => m.role);

  it("goes just before the user's last message, so their words stay last", () => {
    const ms = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
    insertBeforeLastUser(ms, { role: "custom" });
    expect(roles(ms)).toEqual(["user", "assistant", "custom", "user"]);
  });

  it("goes last when there's no user turn yet", () => {
    const ms = [{ role: "assistant" }];
    insertBeforeLastUser(ms, { role: "custom" });
    expect(roles(ms)).toEqual(["assistant", "custom"]);
  });
});
