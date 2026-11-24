/*
 * The host checks every handler call against dist/manifest.json, input and output, and refuses
 * one that does not match — and refuses outright a schema naming a type JSON Schema does not have.
 * So what the handlers send and what the manifest publishes must agree. Two ways they stopped
 * agreeing here: `recordListen`'s optional `finished` was published as `{ type: "undefined" }`
 * twice over, so every listen was refused before it was written, and Maestro's `conversation`
 * was published as a plain string while a turn with no conversation sends null.
 *
 * Each handler runs from the built dist/ against a gateway answering with null in every field the
 * catalogue or the graph may leave empty, and what it sends is held to its published schema.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

type Entry = { namespace: string; name: string; onType?: string; inputSchema: object; outputSchema: object };
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8")) as { entries: Entry[] };
const handlers = createRequire(import.meta.url)("../dist/api/impromptu.js");
const ajv = new Ajv({ allErrors: true });

const entry = (name: string): Entry => {
  const e = manifest.entries.find((x) => x.namespace === "impromptu" && x.name === name);
  if (!e) throw new Error(`no manifest entry for impromptu.${name}`);
  return e;
};

/** Held to the published schema exactly as the host holds it: through JSON. */
const admitted = (schema: object, value: unknown): string[] => {
  const check = ajv.compile(schema);
  return check(JSON.parse(JSON.stringify(value ?? null))) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
};

const types = (schema: unknown): string[] =>
  !schema || typeof schema !== "object" ? []
    : Object.entries(schema).flatMap(([k, v]) => (k === "type" && (typeof v === "string" || Array.isArray(v)) ? [v].flat() : types(v)));

/** A composer and a work with every field the catalogue may leave out sent as null. */
const sparseComposer = { id: "1", name: null, complete_name: null, epoch: null, birth: null, death: null, portrait: null };
const sparseWork = { id: "9", title: null, subtitle: null, genre: null, popular: null, recommended: null };

const gateway = {
  openopus: {
    omnisearch: async () => ({ results: [{ composer: sparseComposer, work: null }] }),
    composerByIds: async () => ({ composers: [sparseComposer, null] }),
    composersByEpoch: async () => ({ composers: [sparseComposer] }),
    worksByGenre: async () => ({ composer: null, works: [sparseWork] }),
    popularComposers: async () => ({ composers: [sparseComposer] }),
  },
  kg: { query: async () => ({ rows: [{ id: null, name: null, knowledge: null, challenge: null, challengeNote: null }] }) },
  repository: { createEntry: async () => ({ id: "entry-1" }) },
  ai: { complete: async () => "Try the slow movement." },
};

describe("the published schemas", () => {
  it("use only JSON Schema types", () => {
    const allowed = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
    for (const e of manifest.entries) {
      expect(types(e.inputSchema).filter((t) => !allowed.has(t)), `${e.name} input`).toEqual([]);
      expect(types(e.outputSchema).filter((t) => !allowed.has(t)), `${e.name} output`).toEqual([]);
    }
  });

  it("compile, every one", () => {
    for (const e of manifest.entries) {
      expect(() => ajv.compile(e.inputSchema), `${e.name} input`).not.toThrow();
      expect(() => ajv.compile(e.outputSchema), `${e.name} output`).not.toThrow();
    }
  });
});

describe("each handler's call and reply, against its own schema", () => {
  it.each([
    ["findComposersByIds", { ids: ["1", "2"] }],
    ["findComposersByName", { name: "Buxtehude" }],
    ["findComposersOfEra", { eras: ["Baroque"] }],
    ["findWorksOfComposer", { composerIds: ["1"] }],
    ["popularComposers", {}],
    ["recordListen", { workId: "9", finished: true }],
    ["rateWork", { workId: "9", rating: 7 }],
    ["recordTaste", { kind: "instrument", value: "solo piano", stance: "curious" }],
    ["recordListenerLevel", { challenge: 6 }],
    ["askMaestro", { question: "What next?" }],
    ["guides", {}],
  ])("%s", async (name, args) => {
    const e = entry(name);
    expect(admitted(e.inputSchema, args), "input").toEqual([]);
    const reply = await handlers[name](gateway, args);
    expect(admitted(e.outputSchema, reply), "output").toEqual([]);
  });
});
