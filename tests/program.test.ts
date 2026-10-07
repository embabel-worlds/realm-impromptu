/**
 * Tests for the concert-programme lens's deterministic core (src/lens/program.ts)
 * — the arithmetic half the LLM is unreliable at. The aesthetic arrangement
 * itself is the LLM's job and is not unit-tested here; these guard that a garbled
 * or over-long reply can never produce a broken or out-of-budget programme.
 */
import { describe, it, expect } from "vitest";
import { parseArrangement, fitToBudget } from "../src/lens/program";

describe("parseArrangement", () => {
  it("parses a clean reply and coerces the fields", () => {
    const text = JSON.stringify({
      title: "An Evening of Contrasts",
      pieces: [
        { n: 2, minutes: 12, role: "opener", note: "bright start" },
        { n: 5, minutes: 33, role: "finale", note: "the climax" },
      ],
    });
    const { title, pieces } = parseArrangement(text, 6);
    expect(title).toBe("An Evening of Contrasts");
    expect(pieces).toEqual([
      { n: 2, minutes: 12, role: "opener", note: "bright start" },
      { n: 5, minutes: 33, role: "finale", note: "the climax" },
    ]);
  });

  it("strips ```json code fences the model often adds", () => {
    const text = "```json\n{\"title\":\"T\",\"pieces\":[{\"n\":1,\"minutes\":10,\"role\":\"opener\"}]}\n```";
    const { title, pieces } = parseArrangement(text, 3);
    expect(title).toBe("T");
    expect(pieces).toHaveLength(1);
    expect(pieces[0].n).toBe(1);
  });

  it("drops pieces whose n is out of range or duplicated", () => {
    const text = JSON.stringify({
      pieces: [
        { n: 1, minutes: 10, role: "opener" },
        { n: 9, minutes: 10, role: "contrast" }, // out of range (pool size 3)
        { n: 1, minutes: 10, role: "finale" }, // duplicate of the opener
        { n: 3, minutes: 20, role: "finale" },
      ],
    });
    const { pieces } = parseArrangement(text, 3);
    expect(pieces.map((p) => p.n)).toEqual([1, 3]);
  });

  it("defaults minutes to at least 1 and tolerates missing role/note", () => {
    const text = JSON.stringify({ pieces: [{ n: 1 }] });
    const { pieces } = parseArrangement(text, 2);
    expect(pieces[0]).toEqual({ n: 1, minutes: 1, role: "", note: "" });
  });

  it("returns an empty arrangement for a non-JSON reply", () => {
    expect(parseArrangement("sorry, I can't help with that", 5)).toEqual({
      title: "",
      pieces: [],
    });
  });
});

describe("fitToBudget", () => {
  const piece = (n: number, minutes: number, role: string) => ({ n, minutes, role, note: "" });

  it("leaves a within-budget programme untouched", () => {
    const pieces = [piece(1, 12, "opener"), piece(2, 25, "centrepiece"), piece(3, 33, "finale")];
    const fit = fitToBudget(pieces, 90);
    expect(fit.dropped).toEqual([]);
    expect(fit.kept).toEqual(pieces);
    expect(fit.total).toBe(70);
  });

  it("trims middle works when over budget, keeping opener and finale", () => {
    const pieces = [
      piece(1, 12, "opener"),
      piece(2, 30, "contrast"),
      piece(3, 30, "centrepiece"),
      piece(4, 33, "finale"),
    ];
    // 105 min vs a 60 min target (ceiling 69) — must trim the middle.
    const fit = fitToBudget(pieces, 60);
    expect(fit.kept[0].role).toBe("opener");
    expect(fit.kept[fit.kept.length - 1].role).toBe("finale");
    expect(fit.dropped.length).toBeGreaterThan(0);
    expect(fit.dropped.every((p) => p.role !== "opener" && p.role !== "finale")).toBe(true);
    expect(fit.total).toBeLessThanOrEqual(60 * 1.15);
  });

  it("drops the LAST non-anchor first (preserving the earlier contrast)", () => {
    const pieces = [
      piece(1, 12, "opener"),
      piece(2, 30, "contrast"),
      piece(3, 30, "pre-interval"),
      piece(4, 33, "finale"),
    ];
    // 105 min vs an 80 min target (ceiling 92) — one drop suffices, so the LAST
    // non-anchor (the pre-interval) goes and the earlier contrast survives.
    const fit = fitToBudget(pieces, 80);
    expect(fit.dropped.map((p) => p.n)).toEqual([3]);
    expect(fit.kept.map((p) => p.n)).toEqual([1, 2, 4]);
  });

  it("never trims below two works even if still over budget", () => {
    const pieces = [piece(1, 60, "opener"), piece(2, 60, "finale")];
    const fit = fitToBudget(pieces, 30);
    expect(fit.kept).toHaveLength(2);
    expect(fit.dropped).toEqual([]);
  });
});
