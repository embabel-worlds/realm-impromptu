/*
 * The catalogue verbs, against a mocked gateway. No keys, no network.
 *
 * What is actually worth testing here is the three disagreements between the catalogue's JSON and
 * the realm's types, because each one was a real bug waiting: snake_case leaking into a graph
 * property, a work arriving with no composer and therefore no `searchQuery` (which silently breaks
 * HAS_RECORDING rather than failing), and `prePiano` being derived from the wrong date.
 */
import { describe, expect, it, vi } from "vitest";
import {
  findComposersByIds,
  findComposersByName,
  findComposersOfEra,
  findWorksOfComposer,
  popularComposers,
  stripUngroundedLinks,
} from "../src/api/impromptu.js";

const BRAHMS = {
  id: "80",
  name: "Brahms",
  complete_name: "Johannes Brahms",
  epoch: "Romantic",
  birth: "1833-01-01",
  death: "1897-01-01",
  portrait: "https://assets.openopus.org/portraits/brahms.jpg",
};
const RAMEAU = {
  id: "178",
  name: "Rameau",
  complete_name: "Jean-Philippe Rameau",
  epoch: "Baroque",
  birth: "1683-01-01",
  death: "1764-01-01",
  portrait: "",
};
const LIVING = { id: "999", name: "Adès", complete_name: "Thomas Adès", epoch: "21st Century", birth: "1971-01-01", death: "" };

const gatewayWith = (openopus: Record<string, unknown>) => ({ openopus }) as never;

describe("findComposersByIds", () => {
  it("batches every id into ONE call — the whole reason this is a verb", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [BRAHMS, RAMEAU] });
    const out = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80", "178"] });
    expect(composerByIds).toHaveBeenCalledTimes(1);
    expect(composerByIds).toHaveBeenCalledWith({ ids: "80,178" });
    expect(out.map((c) => c.composerId)).toEqual(["80", "178"]);
  });

  it("renames complete_name, which is the wart that would otherwise reach every view", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [BRAHMS] });
    const [c] = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80"] });
    expect(c.completeName).toBe("Johannes Brahms");
    expect(c as unknown as Record<string, unknown>).not.toHaveProperty("complete_name");
  });

  it("dedupes and drops blank ids rather than sending them", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [BRAHMS] });
    await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80", " 80 ", "", "  "] });
    expect(composerByIds).toHaveBeenCalledWith({ ids: "80" });
  });

  it("makes no call at all for an empty key list", async () => {
    const composerByIds = vi.fn();
    expect(await findComposersByIds(gatewayWith({ composerByIds }), { ids: [] })).toEqual([]);
    expect(composerByIds).not.toHaveBeenCalled();
  });

  it("drops a record the catalogue returned without an id — it could not be joined to anything", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [BRAHMS, { name: "Nobody" }] });
    const out = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80"] });
    expect(out).toHaveLength(1);
  });

  it("survives a response with no composers key", async () => {
    const composerByIds = vi.fn().mockResolvedValue({});
    expect(await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80"] })).toEqual([]);
  });
});

describe("prePiano", () => {
  /*
   * The one derived field, and the reason it is derived in code: these three cases are exactly the
   * ones a model got wrong when asked to judge from a date in a prompt.
   */
  it("is true for a composer who died before 1850", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [RAMEAU] });
    const [c] = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["178"] });
    expect(c.prePiano).toBe(true);
  });

  it("is false for a composer who died after 1850, however early they were born", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [BRAHMS] });
    const [c] = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["80"] });
    expect(c.prePiano).toBe(false);
  });

  it("is false for the living, who have no death year at all", async () => {
    const composerByIds = vi.fn().mockResolvedValue({ composers: [LIVING] });
    const [c] = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["999"] });
    expect(c.prePiano).toBe(false);
  });

  it("keys on DEATH, not birth: someone born in 1800 who died in 1870 is not pre-modern", async () => {
    const composerByIds = vi.fn().mockResolvedValue({
      composers: [{ id: "7", name: "Late", complete_name: "Born Early Died Late", birth: "1800-01-01", death: "1870-01-01" }],
    });
    const [c] = await findComposersByIds(gatewayWith({ composerByIds }), { ids: ["7"] });
    expect(c.prePiano).toBe(false);
  });
});

describe("findWorksOfComposer", () => {
  const response = {
    composer: BRAHMS,
    works: [
      { id: "7757", title: "Clarinet Quintet in B minor, op. 115", subtitle: "", genre: "Chamber", popular: "1" },
      { id: "7651", title: "Academic Festival Overture, op. 80", subtitle: "", genre: "Orchestral", popular: "1" },
    ],
  };

  it("joins each work to the composer at the TOP of the response — the join a JSONPath cannot make", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(response);
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(out.every((w) => w.composer === "Brahms")).toBe(true);
  });

  it("assembles searchQuery as '<composer> <title>' — the join key HAS_RECORDING needs", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(response);
    const [w] = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(w.searchQuery).toBe("Brahms Clarinet Quintet in B minor, op. 115");
  });

  it("echoes the anchor key onto every work so HAS_WORK can link it back", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(response);
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(out.every((w) => w.ofComposer === "80")).toBe(true);
  });

  it("defaults to the catalogue's 'Popular' pseudo-genre and honours an explicit one", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(response);
    await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(worksByGenre).toHaveBeenCalledWith({ composerId: "80", genre: "Popular" });
    await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"], genre: "Chamber" });
    expect(worksByGenre).toHaveBeenLastCalledWith({ composerId: "80", genre: "Chamber" });
  });

  it("turns the catalogue's '1'/'0' popular string into a boolean", async () => {
    const worksByGenre = vi.fn().mockResolvedValue({
      composer: BRAHMS,
      works: [{ id: "1", title: "Famous", genre: "Orchestral", popular: "1" },
              { id: "2", title: "Obscure", genre: "Orchestral", popular: "0" }],
    });
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(out.map((w) => w.popular)).toEqual([true, false]);
  });

  it("still produces a usable searchQuery when the catalogue omits the composer", async () => {
    const worksByGenre = vi.fn().mockResolvedValue({ works: [{ id: "1", title: "Orphan Work" }] });
    const [w] = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["80"] });
    expect(w.searchQuery).toBe("Orphan Work");
  });
});

describe("findComposersByName", () => {
  it("takes the first hit that has a composer, even when the catalogue answers with a work", async () => {
    const omnisearch = vi.fn().mockResolvedValue({
      results: [{ composer: null, work: null }, { composer: RAMEAU, work: { id: "1", title: "Les Indes galantes" } }],
    });
    const [c] = await findComposersByName(gatewayWith({ omnisearch }), { name: "Rameau" });
    expect(c.composerId).toBe("178");
    expect(c.prePiano).toBe(true);
  });

  it("echoes the name it was asked for, so INFLUENCED_BY links back to its anchor", async () => {
    const omnisearch = vi.fn().mockResolvedValue({ results: [{ composer: RAMEAU }] });
    const [c] = await findComposersByName(gatewayWith({ omnisearch }), { name: "Rameau" });
    expect(c.influenced).toBe("Rameau");
  });

  it("returns an empty list for a name the catalogue does not know, so the edge is dropped", async () => {
    const omnisearch = vi.fn().mockResolvedValue({ results: [] });
    expect(await findComposersByName(gatewayWith({ omnisearch }), { name: "Nobody At All" })).toEqual([]);
  });

  it("makes no call for a blank name", async () => {
    const omnisearch = vi.fn();
    expect(await findComposersByName(gatewayWith({ omnisearch }), { name: "   " })).toEqual([]);
    expect(omnisearch).not.toHaveBeenCalled();
  });
});

describe("findComposersOfEra", () => {
  it("tags every composer with the era it asked for", async () => {
    const composersByEpoch = vi.fn().mockResolvedValue({ composers: [RAMEAU] });
    const out = await findComposersOfEra(gatewayWith({ composersByEpoch }), { eras: ["Baroque"] });
    expect(out[0].ofEra).toBe("Baroque");
  });

  it("asks once per era and keeps the results apart", async () => {
    const composersByEpoch = vi.fn()
      .mockResolvedValueOnce({ composers: [RAMEAU] })
      .mockResolvedValueOnce({ composers: [BRAHMS] });
    const out = await findComposersOfEra(gatewayWith({ composersByEpoch }), { eras: ["Baroque", "Romantic"] });
    expect(composersByEpoch).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.ofEra)).toEqual(["Baroque", "Romantic"]);
  });

  it("returns nothing for an unrecognised era rather than throwing", async () => {
    const composersByEpoch = vi.fn().mockResolvedValue({ composers: null });
    expect(await findComposersOfEra(gatewayWith({ composersByEpoch }), { eras: ["Jazz Age"] })).toEqual([]);
  });
});

describe("popularComposers", () => {
  it("reads the catalogue's own shortlist, with no parameters to get wrong", async () => {
    const popular = vi.fn().mockResolvedValue({ composers: [BRAHMS, RAMEAU] });
    const out = await popularComposers(gatewayWith({ popularComposers: popular }), {});
    expect(popular).toHaveBeenCalledWith({});
    expect(out).toHaveLength(2);
  });
});

describe("stripUngroundedLinks", () => {
  /*
   * The regression guard for the worst thing this realm did in testing: three confident, entirely
   * invented youtube.com/watch links, in a reply whose prompt contained no URL at all and an explicit
   * rule against making one up.
   */
  const FABRICATED = "Seek the [Arditti Quartet](https://www.youtube.com/watch?v=tTXYoU1q4s8) for this.";

  it("removes a link the model was never given, keeping its words", () => {
    const { text, stripped } = stripUngroundedLinks(FABRICATED, []);
    expect(text).toBe("Seek the Arditti Quartet for this.");
    expect(stripped).toEqual(["https://www.youtube.com/watch?v=tTXYoU1q4s8"]);
  });

  it("keeps a link that WAS given, exactly as it arrived", () => {
    const real = "https://www.youtube.com/watch?v=REAL123";
    const md = `Hear the [Dunedin Consort](${real}).`;
    const { text, stripped } = stripUngroundedLinks(md, [real]);
    expect(text).toBe(md);
    expect(stripped).toEqual([]);
  });

  it("keeps the real one and strips the invented one in the same reply", () => {
    const real = "https://www.youtube.com/watch?v=REAL123";
    const { text, stripped } = stripUngroundedLinks(
      `First [good](${real}), then [bad](https://www.youtube.com/watch?v=MADEUP).`,
      [real],
    );
    expect(text).toBe(`First [good](${real}), then bad.`);
    expect(stripped).toHaveLength(1);
  });

  it("is not fooled by a near-miss URL — a different video id is a different recording", () => {
    const { stripped } = stripUngroundedLinks(
      "[x](https://www.youtube.com/watch?v=REAL123&t=30)",
      ["https://www.youtube.com/watch?v=REAL123"],
    );
    expect(stripped).toHaveLength(1);
  });

  it("strips an IMSLP link too — a fabricated score page is the same failure", () => {
    const { text, stripped } = stripUngroundedLinks("the [score](https://imslp.org/wiki/Made_Up)", []);
    expect(text).toBe("the score");
    expect(stripped).toHaveLength(1);
  });

  it("leaves prose with no links untouched, and handles an empty reply", () => {
    expect(stripUngroundedLinks("Just words.", []).text).toBe("Just words.");
    expect(stripUngroundedLinks("", []).text).toBe("");
  });

  it("drops a link whose label is empty rather than leaving brackets behind", () => {
    expect(stripUngroundedLinks("a [](https://example.com/x) b", []).text).toBe("a  b");
  });

  it("ignores blank entries in the allowed set, so a work with no recording allows nothing", () => {
    const { stripped } = stripUngroundedLinks("[x](https://www.youtube.com/watch?v=Q)", ["", undefined as never]);
    expect(stripped).toHaveLength(1);
  });
});

describe("findWorksOfComposer widening", () => {
  /*
   * Rameau, live, has 57 catalogued works and NONE marked popular — and the catalogue answers an empty
   * genre with `success: "false"`, not an empty list, so the browse path looked broken rather than
   * sparse. The composers worth meeting are exactly the ones nobody has shortlisted.
   */
  const emptyGenre = { status: { success: "false", error: "No works found" } };
  const hasWorks = { composer: { id: "178", name: "Rameau", complete_name: "Jean-Philippe Rameau", death: "1764-01-01" },
                     works: [{ id: "20199", title: "Pièces de clavecin", genre: "Keyboard", popular: "0" }] };

  it("widens Popular -> Recommended when the catalogue has no popular works", async () => {
    const worksByGenre = vi.fn().mockResolvedValueOnce(emptyGenre).mockResolvedValueOnce(hasWorks);
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["178"] });
    expect(worksByGenre.mock.calls.map((c) => c[0].genre)).toEqual(["Popular", "Recommended"]);
    expect(out).toHaveLength(1);
  });

  it("widens all the way to 'all', which is the only rung some composers have", async () => {
    const worksByGenre = vi.fn()
      .mockResolvedValueOnce(emptyGenre).mockResolvedValueOnce(emptyGenre).mockResolvedValueOnce(hasWorks);
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["178"] });
    expect(worksByGenre.mock.calls.map((c) => c[0].genre)).toEqual(["Popular", "Recommended", "all"]);
    expect(out).toHaveLength(1);
  });

  it("stops at the first rung that has anything — it widens to FIND works, never to pad them", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(hasWorks);
    await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["178"] });
    expect(worksByGenre).toHaveBeenCalledTimes(1);
  });

  it("does NOT widen past a genre the caller asked for — that would answer a different question", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(emptyGenre);
    const out = await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["178"], genre: "Chamber" });
    expect(worksByGenre).toHaveBeenCalledTimes(1);
    expect(worksByGenre).toHaveBeenCalledWith({ composerId: "178", genre: "Chamber" });
    expect(out).toEqual([]);
  });

  it("returns nothing, without throwing, for a composer the catalogue has no works for at all", async () => {
    const worksByGenre = vi.fn().mockResolvedValue(emptyGenre);
    expect(await findWorksOfComposer(gatewayWith({ worksByGenre }), { composerIds: ["1"] })).toEqual([]);
    expect(worksByGenre).toHaveBeenCalledTimes(3);
  });
});
