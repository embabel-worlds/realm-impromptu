import { Entity } from "@embabel/runtime-types";

// ─── Data shapes ────────────────────────────────────────────────────────────
// Plain records the methods read or write. They have no behaviour of their own,
// so they stay interfaces and live beside the `MusicalWork` type that uses them.

/**
 * A rating of a MusicalWork, attributed to a person. Identity is `ratingKey`
 * (`<raterId>::<workId>`), so one row per (rater, work); the framework also anchors it
 * to the current user via `RATED` on createEntry. Canonical schema lives in
 * `types/music.yml`; this is the slice `MusicalWork.rate` writes.
 */
export interface MusicalWorkRating {
  /** Identity key — `<raterId>::<workId>`, so two people rating the same work are distinct rows. */
  ratingKey: string;
  /** The rater's Person id (the current user's id for their own ratings). */
  raterId: string;
  /** The rater's display name, denormalised for cheap recall. */
  raterName?: string;
  /** Open Opus id of the rated work (same value as MusicalWork.workId) — a property, not the identity by itself. */
  workId: string;
  /** Title, denormalised for cheap recall without a join. */
  title?: string;
  /** Composer, denormalised for cheap recall. */
  composer?: string;
  /** Score from 1 (couldn't stand it) to 10 (masterpiece). Whole numbers only. */
  rating: number;
  /** Optional one-line reaction in the rater's own words. */
  notes?: string;
  /** Optional ISO-8601 date the work was last heard. */
  heardOn?: string;
}

/** The current user's identity, read from the scoped graph to attribute their own ratings. */
export interface CurrentUser {
  id?: string;
  name?: string;
}

/** One Brave web-search hit — the slice the pack reads. */
export interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

/** The Brave `webSearch` response — the slice the pack reads. */
export interface BraveSearchResponse {
  web?: { results?: BraveSearchResult[] };
}

/** One Open Opus omnisearch hit: always a composer, plus a work when the hit is a work. */
export interface OmnisearchHit {
  composer?: { id?: string; name?: string; complete_name?: string; epoch?: string };
  work?: {
    id?: string;
    title?: string;
    subtitle?: string;
    genre?: string;
    popular?: string;
  } | null;
}

/** The Open Opus omnisearch response — the slice the pack reads. */
export interface OmnisearchResponse {
  results?: OmnisearchHit[];
}

/** What the workspace repository returns when a MusicalWorkRating is created or updated. */
export interface RatingEntry {
  id: string;
}

/**
 * The gateway ops `MusicalWork` calls, typed. Until `embabel-pack sync` generates
 * the host's fully-typed `GatewayContext`, a pack types the slice it uses itself and
 * reads it through {@link MusicalWork.api}, so method bodies and return types are
 * fully typed (no `unknown`). Swap this for the generated surface when `sync` lands.
 */
interface ImpromptuGateway {
  brave: {
    webSearch(args: { q: string; count?: number }): Promise<BraveSearchResponse>;
  };
  openopus: { omnisearch(args: { query: string; offset: number }): Promise<OmnisearchResponse> };
  repository: { createEntry(args: { type: string; data: MusicalWorkRating }): Promise<RatingEntry> };
  kg: { query(args: { cypher: string; params: string }): Promise<{ rows?: CurrentUser[] } | CurrentUser[]> };
}

// ─── The type ───────────────────────────────────────────────────────────────

/**
 * A classical musical work in the knowledge graph. Identity is `workId` (the Open
 * Opus id).
 *
 * Extending `Entity` is the whole declaration: it makes the host recognise
 * `MusicalWork` as a type, hydrates an in-scope object's fields onto `this`, and
 * gives it `neighbors()` for free. Each async method below is an affordance callable
 * on that object — `work.recordings({})` — with no `ctx`/`self` plumbing: `this` is
 * the work, `this.api` reaches the APIs the pack brings in (where the credentials
 * live, server-side).
 */
export class MusicalWork extends Entity {
  /** Open Opus work id — the identity key (e.g. "16406"). */
  workId!: string;
  title?: string;
  subtitle?: string;
  composer?: string;
  composerId?: string;
  genre?: string;
  /** '<composer> <title>' — the string used to search YouTube / IMSLP for this work. */
  searchQuery?: string;

  /** The injected gateway, typed to the ops this pack uses. */
  private get api(): ImpromptuGateway {
    return this.gateway as unknown as ImpromptuGateway;
  }

  /** The best free-text query for this work: its stored searchQuery, else composer + title. */
  private query(): string {
    return this.searchQuery || [this.composer, this.title].filter(Boolean).join(" ");
  }

  /**
   * Recordings (performances) of this work — YouTube watch links found via Brave
   * web search restricted to `youtube.com/watch`, so no Google API quota is spent.
   * Each hit's `url` IS the watch link; `title` usually names the performers.
   */
  async recordings(args?: { count?: number }): Promise<BraveSearchResult[]> {
    const res = await this.api.brave.webSearch({
      q: `${this.query()} site:youtube.com/watch`,
      count: (args && args.count) || 8,
    });
    return ((res.web && res.web.results) || []).filter(
      (r) => !!r.url && r.url.includes("youtube.com/watch"),
    );
  }

  /**
   * IMSLP score pages for this work — a Brave web search restricted to imslp.org.
   * Scores are deliberately NOT a graph join (IMSLP lookup is a slow multi-step
   * crawl); this direct search returns the work pages, each of which lists every
   * public-domain edition. Present the page links; never invent a PDF URL.
   */
  async scores(args?: { count?: number }): Promise<BraveSearchResult[]> {
    const res = await this.api.brave.webSearch({
      q: `${this.query()} site:imslp.org`,
      count: (args && args.count) || 5,
    });
    return ((res.web && res.web.results) || []).filter(
      (r) => !!r.url && r.url.includes("imslp.org/wiki/") && !r.url.includes("Category:"),
    );
  }

  /**
   * Fresh Open Opus metadata for this work (re-resolves it by its search string).
   */
  async details(): Promise<OmnisearchResponse> {
    return this.api.openopus.omnisearch({ query: this.query(), offset: 0 });
  }

  /**
   * Record the CURRENT USER's rating of this work (1–10). Recording IS making the link:
   * createEntry against MusicalWorkRating auto-emits (me)-[:RATED]->(MusicalWorkRating) —
   * and `me` is also a Person, so it reads uniformly with other people's ratings. Identity
   * is `<myId>::<workId>`, so a re-rate updates in place. (Attributing a rating to ANOTHER
   * person is a separate flow that resolves that person and links their node.)
   */
  async rate(args: { rating: number; notes?: string; heardOn?: string }): Promise<RatingEntry> {
    const me = await this.currentUser();
    const raterId = me.id || "";
    const data: MusicalWorkRating = {
      ratingKey: `${raterId}::${this.workId}`,
      raterId,
      raterName: me.name,
      workId: this.workId,
      title: this.title,
      composer: this.composer,
      rating: args.rating,
      notes: args.notes,
      heardOn: args.heardOn,
    };
    return this.api.repository.createEntry({ type: "MusicalWorkRating", data });
  }

  /** The current user's own Person id + name, read from the scoped graph. */
  private async currentUser(): Promise<CurrentUser> {
    const res = await this.api.kg.query({
      cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1",
      params: JSON.stringify({}),
    });
    const rows = Array.isArray(res) ? res : res.rows || [];
    return rows[0] || {};
  }
}
