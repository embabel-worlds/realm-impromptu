# realm-impromptu

Classical music you have not met yet, and a guide with opinions about it.

The premise is that recommending music to somebody who already knows what they like is the easy
half. **Two paths lead in, and neither needs you to have rated anything.** The CATALOGUE path is all
facts and no model: Open Opus answers an era, its composers, their dates, their portraits and their
best-known works in one keyless call, so a listener whose only clue is "I liked something old" gets
somewhere. The ASK path takes what they actually said — "forty minutes, nothing soothing" — as a
pinned `ListeningRequest` and generates against it.

What you do is then kept, because a guide that writes nothing down offers you the same piece next
week: what you HEARD (whether or not you scored it), what you thought of it, the boundaries you state
("no solo piano", "period instruments or nothing"), and how hard you want to be pushed. Those are
joinable, which is the point — "something new, nothing you have played me, nothing for solo piano" is
one query.

This is a distillation of the standalone [`impromptu`](https://github.com/embabel/impromptu) app — a
Spring Boot classical-music assistant with hand-coded actions, Neo4j persistence and its own Vaadin
UI — down to what a realm can ship. It supersedes it in everything except Spotify, which needs
per-user OAuth and is not here.

> **Requires [`realm-research`](https://github.com/embabel-worlds/realm-research)** for the Brave web
> search that finds recordings and scores (`gateway.brave.webSearch`), plus a `BRAVE_API_KEY`.
> Without it the catalogue, the ratings, the listening record and every titles-only view still work;
> only the listen and score links go quiet.

## Maestro

The guide you talk to — `/talk maestro`, the app's panel, or any OpenAI client pointed at this world.
He is an **advocate** rather than an answerer, and his positions are authored in
`personalities/maestro/` where an operator can read them before signing him:

1. **No greatest hits.** Not Beethoven's Fifth, not the Four Seasons, not Clair de lune, not the
   famous slow movement lifted out of its symphony. They are mostly great pieces; the objection is to
   being offered nothing else. A famous piece you ASK about gets discussed properly and warmly.
2. **Modern performances**, with the musicians named. The cult of a handful of mid-century conductors
   is mostly about reputation; orchestras play better now.
3. **Period instruments before 1850** — computed from the catalogue's own death years and handed to
   him as a finding, never guessed from a date.
4. **Push you one real step further** than you would go alone, calibrated to how much you know and how
   much difficulty you have asked for.
5. **Teach one idea per reply** — what an exposition is doing when it changes key, what a tone row was
   trying to solve — inside the paragraph about the work it bears on.

He stops when asked, completely: `askedToStop` is a reserved notebook slot, and while it is set the
host withholds his objective entirely.

He arrives off duty with no sponsor, as every realm agent does. `sign_agent` then `set_agent_stage`
before he can be talked to; signing him is signing those five positions.

## The app

`apps/impromptu.html` — a listening room, served at `/apps/impromptu/impromptu.html`. Four concert
halls to choose between (Musikverein, Bayreuth, La Scala, Midnight), the catalogue as a wall of
portraits, a free-text ask box, inline 1–10 rating, your listening record, and Maestro docked beside
it all.

**Playback leaves the page, and that is not a design choice.** Apps are served with a fixed CSP that
declares no `frame-src` and no `media-src`, so a YouTube iframe is refused and so is a remote
`<audio>`. External links go through an `openExternal` chain rather than `target="_blank"`, which does
nothing at all in the Me desktop app. Both constraints are invisible until the page is loaded from the
appliance — see **Testing** below, and embabel/me#2372, embabel/me#2373.

## What's in the realm

| Directory | What it contributes |
|---|---|
| `apis/` | One OpenAPI 3 spec — **Open Opus** (`gateway.openopus.omnisearch`, free/no-auth work metadata). Recordings are YouTube watch links found via **Brave web search** (`gateway.brave.webSearch` with `site:youtube.com/watch` — the YouTube Data API's `search.list` costs 100 quota units per call, ~100 searches/day free), vendored in **[realm-research](../realm-research)** (a shared, reusable capability — NOT MCP), so this realm **requires realm-research** installed. Calls go through the gateway from `execute_javascript`. |
| `types/music.yml` | `MusicalWork` (canonical metadata, keyed by Open Opus id) + `MusicalWorkRating` (the user's score), plus two **virtual** types materialized on demand: `MusicalRecording` (YouTube) and the fan-in `MusicalTasteSummary`. (Printed scores are deliberately NOT a virtual type — the `music` skill searches IMSLP directly in code mode; the crawl is too slow for query-time joins.) Every type is `Musical*`-namespaced so it can't collide with another realm's `Work`/`Recording`/`Score`. |
| `producers/impromptu.yml` | The four virtual-join producers: `similarWorks` (generative `SIMILAR_TO`), `recordingsByWork` (remote `HAS_RECORDING` — YouTube links via Brave search), `workTasteSummary` (aggregate `HAS_MUSICAL_TASTE_SUMMARY`), `tasteBasedWorks` (generative `SUGGESTS`). |
| `skills/music/` | One skill for everything: look up a work, find a recording or score, recommend, rate, recall. Owns the Open Opus + recording-search workflow and the cardinal rules (always search with `<composer> <title>`; never fabricate an id/recording/score). |
| `personalities/maestro/` | Concert-programme-note voice — used only by the recommendation / write-up path. Rate confirmations and recall replies stay in the default assistant voice. |
| `views/` , `lenses/` | Saved Cypher views — tabular "listen + score" recommendations (`WorkRecommendations`, `TasteBasedRecommendations`: composer, work, a YouTube recording, an IMSLP score), cheap browse views (`ChamberRecommendations`, `WorksYoullProbablyDislike`), and `MyMusicTaste` (falls back to "No works rated") — plus JS lenses (`Rated Works`, `Recommendations You Can Hear`, `Your Music Taste`, `Top 3 — Scores`). |
| `focuses/music.yml` | `/focus music` — scopes chat to this realm + the `maestro` persona. |
| `apps/MusicalWork.component.js` | The `MusicalWork` entity card: play button (top YouTube recording), composer, genre badges, and a 1–10 rating widget. |
| `src/api/work.ts` | The **`MusicalWork` type** — a TypeScript class `extends Entity`. Fields are the shape; async methods (`work.recordings`, `work.details`, `work.rate`, inherited `work.neighbors`) are affordances callable on an in-scope object. Built to `dist/`. |

## Setup

- **Open Opus** needs no key.
- **Recording search** (Brave) is provided by **realm-research** — install it and set a
  [Brave Search API](https://brave.com/search/api/) key on the assistant process:
  ```bash
  export BRAVE_API_KEY=...
  ```
  This is a deployment-level key, not per-user OAuth. (No Google/YouTube key: the YouTube
  Data API's `search.list` costs 100 quota units per call — ~100 searches/day free — while
  a Brave hit's `url` is already the watch link.)
- **IMSLP** needs no key — the `music` skill finds score pages with a direct Brave web
  search (`site:imslp.org`); IMSLP's own lookup is a multi-step MediaWiki crawl, so it is
  deliberately not an API integration nor a graph join.

## How a work reaches its recordings and scores

A `MusicalWork` carries a `searchQuery` scalar (`"<composer> <title>"`). That single
string is the join key for both media edges, so the graph can go:

```
(MusicalWorkRating)-[:SIMILAR_TO]->(MusicalWork)-[:HAS_RECORDING]->(MusicalRecording)   # YouTube
```

The recommendation producers (`similarWorks`, `tasteBasedWorks`) resolve each
LLM-suggested work name onto the Open Opus spine (so it dedupes against works the
user already rated) and stamp the suggested `<composer> <title>` as the new work's
`searchQuery` — so a recommended work can chain straight into its recording or score.

## Sample queries

Run these in the Cypher console (Settings → Data → **Query**). Each virtual edge
materializes on demand. Keep a virtual join in the **leading `MATCH` chain** (a join
after a `WITH` is not materialized), and put `LIMIT`/`ORDER BY` at the end.

**Instant (Neo4j only)**
```cypher
-- Your top-rated works
MATCH (me:AssistantUser)-[:RATED]->(r:MusicalWorkRating)
RETURN r.composer, r.title, r.rating ORDER BY r.rating DESC, r.title LIMIT 15
```

**Generative (SIMILAR_TO / fan-IN summary / two-stage SUGGESTS)**
```cypher
-- Recommendations from works you LOVED, excluding what you've rated
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN DISTINCT w.composer, w.title, w.genre LIMIT 15
```
```cypher
-- Your taste in ~100 words (a fan-IN aggregate node over all your ratings)
MATCH (me:AssistantUser)-[:HAS_MUSICAL_TASTE_SUMMARY]->(ts:MusicalTasteSummary)
RETURN ts.summary, ts.count
```
```cypher
-- Recommendations from your WHOLE taste (fan-IN summary → fan-OUT SUGGESTS)
MATCH (me:AssistantUser)-[:HAS_MUSICAL_TASTE_SUMMARY]->(ts:MusicalTasteSummary)
MATCH (ts)-[:SUGGESTS]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN DISTINCT w.composer, w.title, w.genre
```

**Recordings (HAS_RECORDING → YouTube)**
```cypher
-- Recommendations you can listen to right now
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)-[:HAS_RECORDING]->(r:MusicalRecording)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN w.composer, w.title, collect(r.title)[0..2] AS recordings
```

**LLM-judged (the `ai` namespace — steer a generative edge, rank, or filter on subjective taste)**

The `ai` namespace is reserved for per-row LLM judgment over what a virtual join has
fetched or generated — for a discriminator no stored property or embedding captures.
An `{ai: {…}}` directive map on a generative edge *steers and tunes* it (`hint`, plus
`model` — a world role like `chat_cheap` — `temperature`, `confidence`, `fresh`);
`ai.score(...)` *reranks*; `ai.relevant(...)` *filters*. The `hint` is a soft nudge, so
never pair it with a `WHERE` on the same edge.
```cypher
-- Recommendations from the works you loved, but nudge them wistful and autumnal —
-- generated by a cheap model, keeping only confident picks
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO {ai: {hint:'lean melancholic, autumnal, and introspective',
                              model:'chat_cheap', confidence: 0.7}}]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN DISTINCT w.composer, w.title, w.genre LIMIT 15
```
```cypher
-- Your five most adventurous, least-famous picks from your whole taste
MATCH (me:AssistantUser)-[:HAS_MUSICAL_TASTE_SUMMARY]->(ts:MusicalTasteSummary)
MATCH (ts)-[:SUGGESTS]->(w:MusicalWork)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
RETURN w.composer, w.title, w.genre
ORDER BY ai.score(w, 'the most adventurous and least famous — a genuine discovery, not a warhorse') DESC LIMIT 5
```
```cypher
-- Recommendations you can hear, keeping only full-ensemble performances (no piano reductions or reaction videos)
MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)-[:HAS_RECORDING]->(r:MusicalRecording)
WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
  AND ai.relevant(r, 'a full-ensemble performance of the work itself — not a solo-piano arrangement, cover, or reaction video')
RETURN w.composer, w.title, collect(r.title)[0..2] AS recordings
```

You can also click **Run** on the saved views in the console's **Views** tab, and
the lenses ship `Top 3 — Scores` (a direct IMSLP web search per top-rated work —
scores are deliberately not a graph join).

## Multi-person taste

A `MusicalWorkRating` is attributed to a **person** — the current user *or* any contact — via
`(Person)-[:RATED]->(MusicalWorkRating)`, and carries `raterName`/`raterId` (the same model as
[`realm-movie`](../realm-movie)). Your own `AssistantUser` node is also a `Person`, so one uniform edge covers
everyone. The saved forms are `RatingsByRater` / `MutualFavourites` / `DividedOpinions`. These populate once
more than one person has ratings — recording another person's ratings is a **seeding** operation today
(`create_entry` only auto-anchors the current user).

```cypher
-- Works you and one named person both love
MATCH (me:AssistantUser)-[:RATED]->(rm:MusicalWorkRating)          WHERE rm.rating >= 8
MATCH (other:Person)-[:RATED]->(ro:MusicalWorkRating)
  WHERE other <> me AND other.name = 'Ada Lovelace'
    AND ro.rating >= 8 AND ro.workId = rm.workId
RETURN rm.composer AS Composer, rm.title AS Work, rm.rating AS Mine, ro.rating AS Theirs ORDER BY Work
```
```cypher
-- SHARED recommendations — works that appeal to BOTH, new to both. Two SIMILAR_TO fan-outs intersect;
-- works because a generative pick can name every anchor it resembles (sourceIndexes). ~1–2 min.
MATCH (me:AssistantUser)-[:RATED]->(rm:MusicalWorkRating) WHERE rm.rating >= 8
MATCH (rm)-[:SIMILAR_TO]->(w:MusicalWork)
MATCH (other:Person)-[:RATED]->(ro:MusicalWorkRating) WHERE other.name = 'Ada Lovelace' AND ro.rating >= 8
MATCH (ro)-[:SIMILAR_TO]->(w)
WHERE NOT EXISTS { (s:MusicalWorkRating) WHERE s.workId = w.workId }
RETURN DISTINCT w.composer, w.title LIMIT 20
```

## Type methods (`src/api/work.ts`)

`MusicalWork extends Entity`. Its async methods are affordances on an in-scope
work object:

- `work.recordings({ count? })` → YouTube watch links for performances of the work (Brave search).
- `work.details()` → re-resolve the work's Open Opus metadata.
- `work.rate({ rating, notes?, heardOn? })` → record a `MusicalWorkRating` (auto-links `RATED`).
- `work.neighbors({ hops })` → inherited graph walk from this work's node.

Build and test:

```bash
npm install
npm run typecheck
npm test          # vitest — methods run against a mocked gateway, no keys needed
npm run build     # tsc -> dist/ + manifest
```

## Why no separate Composer / Performer entities?

The `impromptu` app models a rich reference graph (Composer, Ensemble, Performer,
Epoch, Genre, Instrument, …). This realm deliberately keeps only `MusicalWork` and
the user's `MusicalWorkRating`: the composer and genre are denormalised onto the
work, recordings and scores are virtual (fetched on demand, never stored), and
anything about the *user's* taste is the DICE proposition graph's job — not a
second entity that drifts. If a deployment wants the full composer graph, that is
Open Opus bulk-population, a separate concern from this query-time realm.

## Testing

```bash
npm run check          # typecheck + build + 52 unit tests + the served-app tests
```

`npm test` is the unit suite: the catalogue reshaping, the `prePiano` derivation, the widening chain,
and the link guard. All mocked — no keys, no network.

`npm run test:app` loads the app **from a running appliance**, with its real response headers, and
fails on any CSP violation or console error. It needs the appliance up and the realm installed:

```bash
IMPROMPTU_TOKEN=<your appliance token> npm run test:app
```

Without the token it skips, loudly. **This test exists because the realm shipped an app whose two
central affordances were both dead** — a YouTube iframe the CSP refuses, and a `target="_blank"` that
does nothing in the desktop app — while all 17 views were green, 52 unit tests passed and
`realm_validate` returned `ok: true`. A CSP lives on the HTTP response, so the offline harness the
other realms use cannot see it. Verified not to be vacuous: injecting the original iframe back in
trips `frame-src blocked` immediately.

`tests/questions.yml` is the natural-language battery — the questions people type, and what a correct
answer has to satisfy. Every entry with a `notes:` field is there because that exact thing went wrong
in testing.
