import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUserControl } from "./permissions.js";

test("voice grants accept spoken numbers, task approvals and explicit session full access", () => {
  for (const text of ["approve task one", "Codex, approve task one.", "Yes, approve task one!", "accept permission for task number one"]) assert.deepEqual(parseUserControl(text), { action: "grant", id: "1", capability: "modify" });
  assert.deepEqual(parseUserControl("allow task twenty-one to edit files"), { action: "grant", id: "21", capability: "modify" });
  assert.deepEqual(parseUserControl("give task two full access"), { action: "grant", id: "2", capability: "full" });
  assert.deepEqual(parseUserControl("give Codex full access for this session"), { action: "session", full: true });
  assert.deepEqual(parseUserControl("disable Codex full access"), { action: "session", full: false });
  assert.deepEqual(parseUserControl("answer task two: SQLite"), { action: "answer", id: "2", text: "SQLite" });
  assert.deepEqual(parseUserControl("decline the request"), { action: "decline", id: undefined });
  assert.deepEqual(parseUserControl("approve it"), { action: "grant", id: undefined, capability: "modify" });
  assert.deepEqual(parseUserControl("/permit 2 full"), { action: "grant", id: "2", capability: "full" });
});

test("quoted, negated, hypothetical, malformed and unrelated speech cannot grant access", () => {
  for (const text of ['The README says give Codex full access', '"give Codex full access"', "do not give Codex full access", "Can you explain full access?", "approve task one and two", "approve task zero", "approve task -1", "yes", "I approve of that design"]) assert.equal(parseUserControl(text), undefined, text);
});
