import type { Capability } from "./tasks.js";

export type UserControl =
  | { action: "session"; full: boolean }
  | { action: "grant"; id?: string; capability: Capability }
  | { action: "decline"; id?: string }
  | { action: "answer"; id: string; text: string }
  | { action: "revoke"; id: string };

/** Deliberately anchored: quoted requests, model output, and source documents cannot grant access. */
export function parseUserControl(input: string): UserControl | undefined {
  let text = input.trim().replace(/^(?:hey\s+)?(?:codex|coding|default|general|deep[ -]?think)[,:]?\s+/i, "").replace(/[.!?]+$/, "").trim();
  text = text.replace(/^(?:please[, ]+|yes[, ]+)/i, "");
  if (/^(?:give|grant|enable|allow) (?:codex )?(?:full access|full permissions|unrestricted access)(?: (?:to|for) codex)?(?: for (?:this|the) session)?$/i.test(text)) return { action: "session", full: true };
  if (/^(?:(?:disable|revoke|turn off) (?:codex(?:'s)? )?full access|restrict codex to (?:this|the) project)$/i.test(text)) return { action: "session", full: false };
  const answer = /^(?:answer|tell) task ([\w -]+?)(?:\s*[:,]\s*|\s+that\s+)(.+)$/i.exec(text);
  if (answer) { const id = taskNumber(answer[1]!); if (id) return { action: "answer", id, text: answer[2]! }; }
  const short = /^\/(permit|revoke)\s+(\d+)(?:\s+(read|execute|modify|full))?$/i.exec(text);
  if (short) {
    if (short[1]!.toLowerCase() === "revoke") return { action: "revoke", id: short[2]! };
    if (short[3]) return { action: "grant", id: short[2]!, capability: short[3]!.toLowerCase() as Capability };
  }
  const full = /^(?:give|grant|allow) task ([\w -]+?) (?:full access|full permissions)$/i.exec(text);
  if (full) { const id = taskNumber(full[1]!); if (id) return { action: "grant", id, capability: "full" }; }
  const grant = /^(?:allow|permit) task ([\w -]+?) to (modify|edit|write|execute|run|read)(?: files| commands| code)?$/i.exec(text);
  if (grant) { const id = taskNumber(grant[1]!); if (id) return { action: "grant", id, capability: /modify|edit|write/i.test(grant[2]!) ? "modify" : /execute|run/i.test(grant[2]!) ? "execute" : "read" }; }
  const approve = /^(approve|accept|allow|deny|decline|reject|revoke|cancel)(?: (?:permission for |permissions for )?task ([\w -]+)| (?:it|that|the request))?$/i.exec(text);
  if (approve) {
    const id = approve[2] ? taskNumber(approve[2]) : undefined;
    if (approve[2] && !id) return;
    if (/revoke|cancel/i.test(approve[1]!)) return id ? { action: "revoke", id } : undefined;
    return /deny|decline|reject/i.test(approve[1]!) ? { action: "decline", id } : { action: "grant", id, capability: "modify" };
  }
  return undefined;
}

function taskNumber(text: string): string | undefined {
  text = text.toLowerCase().trim().replace(/-/g, " ").replace(/^number /, "");
  if (/^[1-9]\d*$/.test(text)) return text;
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const small = ones.indexOf(text); if (small > 0) return String(small);
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const words = text.split(" "), ten = tens.indexOf(words[0]!), one = words.length === 1 ? 0 : ones.indexOf(words[1]!);
  return ten >= 2 && words.length <= 2 && one >= 0 && one <= 9 ? String(ten * 10 + one) : undefined;
}
