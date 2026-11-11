/** Incremental speech chunks. A timer bounds waiting for punctuation without splitting words. */
export class SpeechChunker {
  private buffer = "";
  private since = 0;
  constructor(readonly maxChars = 180, readonly maxWaitMs = 250) {}
  push(delta: string, now = performance.now()): string[] {
    if (!this.buffer) this.since = now;
    this.buffer += delta;
    return this.take(now, false);
  }
  tick(now = performance.now()): string[] { return this.take(now, false); }
  flush(): string[] { const s = this.clean(this.buffer); this.buffer = ""; return s ? [s] : []; }
  private clean(s: string): string { return s.replace(/[*#`]/g, "").replace(/\s+/g, " ").trim(); }
  private take(now: number, final: boolean): string[] {
    const result: string[] = [];
    while (this.buffer) {
      // Look ahead for whitespace, so a streamed decimal or URL isn't split at a period.
      const boundary = /[.!?;](?:["')])?\s|\n/.exec(this.buffer);
      let cut = boundary ? boundary.index + boundary[0].length : 0;
      if (!cut && (this.buffer.length >= this.maxChars || (now - this.since >= this.maxWaitMs && this.buffer.trim().length >= 24))) {
        const limit = Math.min(this.maxChars, this.buffer.length);
        cut = this.buffer.lastIndexOf(" ", limit);
        if (cut < 12) cut = 0;
      }
      if (!cut && !final) break;
      const raw = this.buffer.slice(0, cut || undefined);
      this.buffer = cut ? this.buffer.slice(cut) : "";
      const text = this.clean(raw); if (text) result.push(text);
      this.since = now;
    }
    return result;
  }
}
