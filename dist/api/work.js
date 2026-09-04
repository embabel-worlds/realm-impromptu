"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MusicalWork = void 0;
const runtime_types_1 = require("@embabel/runtime-types");
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
class MusicalWork extends runtime_types_1.Entity {
    /** Open Opus work id — the identity key (e.g. "16406"). */
    workId;
    title;
    subtitle;
    composer;
    composerId;
    genre;
    /** '<composer> <title>' — the string used to search YouTube / IMSLP for this work. */
    searchQuery;
    /** The injected gateway, typed to the ops this pack uses. */
    get api() {
        return this.gateway;
    }
    /** The best free-text query for this work: its stored searchQuery, else composer + title. */
    query() {
        return this.searchQuery || [this.composer, this.title].filter(Boolean).join(" ");
    }
    /**
     * Recordings (performances) of this work — YouTube watch links found via Brave
     * web search restricted to `youtube.com/watch`, so no Google API quota is spent.
     * Each hit's `url` IS the watch link; `title` usually names the performers.
     */
    async recordings(args) {
        const res = await this.api.brave.webSearch({
            q: `${this.query()} site:youtube.com/watch`,
            count: (args && args.count) || 8,
        });
        return ((res.web && res.web.results) || []).filter((r) => !!r.url && r.url.includes("youtube.com/watch"));
    }
    /**
     * IMSLP score pages for this work — a Brave web search restricted to imslp.org.
     * Scores are deliberately NOT a graph join (IMSLP lookup is a slow multi-step
     * crawl); this direct search returns the work pages, each of which lists every
     * public-domain edition. Present the page links; never invent a PDF URL.
     */
    async scores(args) {
        const res = await this.api.brave.webSearch({
            q: `${this.query()} site:imslp.org`,
            count: (args && args.count) || 5,
        });
        return ((res.web && res.web.results) || []).filter((r) => !!r.url && r.url.includes("imslp.org/wiki/") && !r.url.includes("Category:"));
    }
    /**
     * Fresh Open Opus metadata for this work (re-resolves it by its search string).
     */
    async details() {
        return this.api.openopus.omnisearch({ query: this.query(), offset: 0 });
    }
    /**
     * Record the CURRENT USER's rating of this work (1–10). Recording IS making the link:
     * createEntry against MusicalWorkRating auto-emits (me)-[:RATED]->(MusicalWorkRating) —
     * and `me` is also a Person, so it reads uniformly with other people's ratings. Identity
     * is `<myId>::<workId>`, so a re-rate updates in place. (Attributing a rating to ANOTHER
     * person is a separate flow that resolves that person and links their node.)
     */
    async rate(args) {
        const me = await this.currentUser();
        const raterId = me.id || "";
        const data = {
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
    async currentUser() {
        const res = await this.api.kg.query({
            cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1",
            params: JSON.stringify({}),
        });
        const rows = Array.isArray(res) ? res : res.rows || [];
        return rows[0] || {};
    }
}
exports.MusicalWork = MusicalWork;
