/**
 * Tests for the `MusicalWork` type's methods. Each runs against a MOCKED gateway
 * (no live server, no API keys): `entityForTest` builds a real `MusicalWork` with
 * its fields set and the mock gateway injected — exactly what the host does at
 * runtime — so the method under test runs unchanged. We then assert it called the
 * right underlying gateway op with the right args.
 */
import { describe, it, expect, vi } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { MusicalWork } from "../src/api/work";

describe("MusicalWork.recordings", () => {
  it("brave-searches youtube.com/watch for the stored searchQuery and keeps only watch links", async () => {
    const webSearch = vi.fn().mockResolvedValue({
      web: {
        results: [
          { url: "https://www.youtube.com/watch?v=abc123", title: "Symphony No. 5 / Karajan" },
          { url: "https://www.youtube.com/channel/UCx", title: "Some channel page" },
        ],
      },
    });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", searchQuery: "Beethoven Symphony no. 5 in C minor" },
      mockGateway<GenericGatewayContext>({ brave: { webSearch } }),
    );

    const r = await work.recordings();

    expect(webSearch).toHaveBeenCalledWith({
      q: "Beethoven Symphony no. 5 in C minor site:youtube.com/watch",
      count: 8,
    });
    expect(r).toEqual([
      { url: "https://www.youtube.com/watch?v=abc123", title: "Symphony No. 5 / Karajan" },
    ]);
  });

  it("falls back to composer + title when searchQuery is absent", async () => {
    const webSearch = vi.fn().mockResolvedValue({ web: { results: [] } });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", composer: "Beethoven", title: "Symphony no. 5" },
      mockGateway<GenericGatewayContext>({ brave: { webSearch } }),
    );

    await work.recordings({ count: 3 });

    expect(webSearch).toHaveBeenCalledWith({
      q: "Beethoven Symphony no. 5 site:youtube.com/watch",
      count: 3,
    });
  });
});

describe("MusicalWork.scores", () => {
  it("brave-searches imslp.org and keeps only work pages", async () => {
    const webSearch = vi.fn().mockResolvedValue({
      web: {
        results: [
          { url: "https://imslp.org/wiki/Symphony_No.5_(Beethoven,_Ludwig_van)", title: "Symphony No.5 (Beethoven)" },
          { url: "https://imslp.org/wiki/Category:Beethoven,_Ludwig_van", title: "Category page" },
          { url: "https://example.com/scores", title: "Not IMSLP" },
        ],
      },
    });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", searchQuery: "Beethoven Symphony no. 5 in C minor" },
      mockGateway<GenericGatewayContext>({ brave: { webSearch } }),
    );

    const r = await work.scores();

    expect(webSearch).toHaveBeenCalledWith({
      q: "Beethoven Symphony no. 5 in C minor site:imslp.org",
      count: 5,
    });
    expect(r).toEqual([
      { url: "https://imslp.org/wiki/Symphony_No.5_(Beethoven,_Ludwig_van)", title: "Symphony No.5 (Beethoven)" },
    ]);
  });
});

describe("MusicalWork.details", () => {
  it("re-resolves the work via Open Opus omnisearch on its search string", async () => {
    const omnisearch = vi.fn().mockResolvedValue({ results: [{ work: { id: "16406" } }] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", searchQuery: "Beethoven Symphony no. 5" },
      mockGateway<GenericGatewayContext>({ openopus: { omnisearch } }),
    );

    const r = await work.details();

    expect(omnisearch).toHaveBeenCalledWith({ query: "Beethoven Symphony no. 5", offset: 0 });
    expect(r).toMatchObject({ results: [{ work: { id: "16406" } }] });
  });
});

describe("MusicalWork.rate", () => {
  it("attributes the rating to the current user with a rater-inclusive identity key", async () => {
    const createEntry = vi.fn().mockResolvedValue({ id: "wr1" });
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "rod_johnson_assistant", name: "Rod Johnson" }] });
    const work = entityForTest(
      MusicalWork,
      { workId: "16406", title: "Symphony no. 5 in C minor, op. 67", composer: "Beethoven" },
      mockGateway<GenericGatewayContext>({ repository: { createEntry }, kg: { query } }),
    );

    await work.rate({ rating: 9, notes: "the four notes" });

    expect(createEntry).toHaveBeenCalledWith({
      type: "MusicalWorkRating",
      data: {
        ratingKey: "rod_johnson_assistant::16406",
        raterId: "rod_johnson_assistant",
        raterName: "Rod Johnson",
        workId: "16406",
        title: "Symphony no. 5 in C minor, op. 67",
        composer: "Beethoven",
        rating: 9,
        notes: "the four notes",
        heardOn: undefined,
      },
    });
  });
});

describe("MusicalWork.neighbors (inherited from Entity)", () => {
  it("walks the graph from this work's id via kg.neighbors — no per-type code", async () => {
    const neighbors = vi.fn().mockResolvedValue([{ id: "c1", label: "Composer", name: "Beethoven" }]);
    const work = entityForTest(
      MusicalWork,
      { id: "work-16406", workId: "16406" },
      mockGateway<GenericGatewayContext>({ kg: { neighbors } }),
    );

    const r = await work.neighbors({ hops: 2 });

    expect(neighbors).toHaveBeenCalledWith({ id: "work-16406", hops: 2 });
    expect(r).toMatchObject([{ name: "Beethoven" }]);
  });
});
