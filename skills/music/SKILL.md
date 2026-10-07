---
name: music
description: Classical / art music — work facts (this realm's Open Opus source is authoritative, NOT web search), recordings (YouTube links), scores (IMSLP), recommendations, and ratings. Activate for ANY classical-music request; it returns the methods and rules to follow.
---

# Classical music

One skill for everything classical-music-related. The realm ships one API
(`openopus`), the `MusicalWork` and `MusicalWorkRating` world types (plus
the virtual `MusicalRecording`), and the `maestro` personality
(concert-programme voice for write-ups). Recording and score searches ride
`gateway.brave.…` from **realm-research** (required for those only).

All API calls go through `gateway.<ns>.<method>(args)` from inside
`execute_javascript` — never as top-level tools.

| Surface | Shape |
|---|---|
| `gateway.openopus.omnisearch({ query, offset })` | Free-text "composer + work" search, e.g. `{ query: "Beethoven Symphony 5", offset: 0 }`. Returns `{ results: [{ composer, work }] }` — take the FIRST result whose `work` is non-null. |
| `gateway.brave.webSearch({ q, count })` | Web search (vendored in realm-research — REQUIRES it installed). For recordings: `q` = `"<composer> <title> site:youtube.com/watch"`; each hit's `url` IS the watch link. |
| `view_run` (top-level MCP tool) | Run a SAVED VIEW by name — the curated read surface. **Prefer a matching view over writing your own query**; discover names/params via `query_guide`. |
| `gateway.kg.query({ cypher, params })` | Hand-written Cypher — ONLY when no saved view fits (a steered, filtered, or novel shape). |
| reads → `view_run` / `gateway.kg.query` | There is NO `listEntries`. Read world entries through the graph — a saved view (`view_run`) or hand-written Cypher. `gateway.repository` is create / update / delete + `describe` only. |
| `gateway.repository.createEntry({ type, data, relations })` | Create/merge an entry (MERGEs on the identity key). |

## Look up a work — "tell me about X", who wrote it, what genre

This is the default for any factual question about a specific work.

```js
const res = await gateway.openopus.omnisearch({ query: "Sibelius Violin Concerto", offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `Open Opus has no work matching that — ask the user to confirm composer and title.`;
const work = hit.work, composer = hit.composer;
// Answer from the structured record: work.title, work.subtitle, work.genre, composer.name,
// composer.complete_name, composer.epoch. Authoritative for work facts — prefer it over web search.
```

To keep the work in scope for follow-ups ("find me a recording", "is there a
score"), **create it** — that also sets its `searchQuery`, the key the recording
and score joins need:

```js
const searchQuery = `${composer.name} ${work.title}`;
await gateway.repository.createEntry({ type: "MusicalWork", data: {
  workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
  composerId: composer.id, genre: work.genre, popular: work.popular === "1", searchQuery,
} });
```

## "Find me a recording of X" / "where can I hear X"

Search the web restricted to YouTube watch pages — each hit's `url` IS the link:

```js
const q = "Beethoven Symphony no. 5 in C minor";   // composer + title
const res = await gateway.brave.webSearch({ q: q + " site:youtube.com/watch", count: 8 });
const hits = ((res.web && res.web.results) || []).filter((r) => r.url && r.url.includes("youtube.com/watch"));
// Each hit: url (the watch link), title (usually names performers), description.
```

Prefer results whose title names a real orchestra / conductor / soloist. **If
the call errors, SAY the tool failed — never invent a video link.** If the user
adds a performer ("the Karajan one"), append it to `q`.

## "Is there a score for X?" (IMSLP)

Scores are deliberately NOT a graph join — IMSLP lookup is a slow crawl, wrong
for query time. Search IMSLP directly (fast, ~1s per work):

```js
const q = "Beethoven Symphony no. 5 in C minor";   // '<composer> <title>'
const res = await gateway.brave.webSearch({ q: q + " site:imslp.org", count: 5 });
const pages = ((res.web && res.web.results) || [])
  .filter((r) => r.url && r.url.includes("imslp.org/wiki/") && !r.url.includes("Category:"));
// Each hit is an IMSLP WORK PAGE listing every public-domain edition — present the page links.
// Want actual PDF links? fetch() the page and extract hrefs containing '/wiki/File:' or 'imslp.org/images'.
```

Only present IMSLP pages you actually found. If none come back, say so — don't
point at a paywalled edition or invent a link.

## "What should I listen to?" — a recommendation

**Start with the saved views** — one `view_run` call each, no hand-written Cypher:

- `WorkRecommendations` — top 5 from works they've loved, each WITH a recording. The default.
- `TasteBasedRecommendations` — picks from their taste as a whole, with recordings.
- `ChamberRecommendations` / `WorksYoullProbablyDislike` — fast titles-only cuts.
- `MyMusicTaste` — their taste in ~100 words (or "No works rated").

Write your own query ONLY when the request doesn't fit a view — typically a
mood/form-steered ask, where the constraint goes on the edge as `{ai: {hint}}`.
Even then, ONE virtual-cypher query covers picks + recordings: generate, exclude
what they've rated, and join every pick to a recording — all in the leading
MATCH block. Do NOT split this into a ratings read plus per-work recording
searches: `HAS_RECORDING` runs those fetches inside the engine, per work, cached.
Scores are NOT part of this query — fetch them on demand for the works the user
picks (see the score section above).

```js
const rows = await gateway.kg.query({
  cypher: `MATCH (me:AssistantUser)-[:RATED]->(rt:MusicalWorkRating) WHERE rt.rating >= 8
           MATCH (rt)-[:SIMILAR_TO]->(w:MusicalWork)
           WHERE NOT EXISTS { (me)-[:RATED]->(seen:MusicalWorkRating) WHERE seen.workId = w.workId }
           MATCH (w)-[:HAS_RECORDING]->(r:MusicalRecording)
           WITH w, count(DISTINCT rt) AS overlap,
                head(collect(DISTINCT r)) AS rec
           RETURN w.composer AS composer, w.title AS title, w.genre AS genre,
                  rec.title AS performance,
                  rec.url AS watch
           ORDER BY overlap DESC, title ASC LIMIT 5`,
  params: JSON.stringify({}),
});
// Generative SIMILAR_TO + one recording search PER pick, engine-side — give it a
// minute on a cold cache and tell the user it's working.
```

- **Steer, don't post-filter**: a mood/form constraint goes on the edge as
  `-[:SIMILAR_TO {ai: {hint:'…'}}]->`; drop the `w.genre` filter equivalent.
- **Honour preferences** from the user's profile (composers, eras, forms they love, the
  instrument they play). If vague ("something good"), ask ONE clarifying question first.
- **No ratings yet** (empty result and no `MusicalWorkRating` rows): suggest a few from
  their profile and OFFER to record ratings so future picks get better.
- **Write up the top 3** in the `maestro` voice — one sound-led paragraph each, with the
  `watch` link the query returned; add IMSLP score links (score section above) when the
  user asked to read along.
- A direct `gateway.brave.webSearch` recording search is ONLY for a need the join
  can't express (a named performer, a score-following video — append that to `q`) —
  never for the default recommendation flow.

## Asking the user to choose — `choices` payloads

Whenever a flow needs the user to pick from a small closed set (a score, one of
several matching works), do NOT guess, do NOT pick silently, and do NOT bury the
options in prose. Instead the script RETURNS a `choices` payload as its result,
and you then present the question and options to the user and STOP — take no
recording/lookup action until they pick. The structured result lets a client
that can render forms show one; everywhere else, present the options as a short
list. The payload shape:

```json
{"kind": "choices",
 "question": "<one short question>",
 "options": ["<option>", "..."],
 "context": { "<ids the follow-up turn needs>": "..." },
 "hint": "Present these options to the user and wait for their pick."}
```

Carry the ids the next turn needs in `context` so you never re-resolve.

### Work named, NO score yet — "Rate Brahms 4 for me", "I heard the Sibelius concerto last night"

Resolve the work via Open Opus first (disambiguates and yields the stable work id),
then return the choices payload and wait:

```js
const userWork = "Brahms Symphony 4";
const res = await gateway.openopus.omnisearch({ query: userWork, offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `No work matching "${userWork}" on Open Opus — confirm the composer and title.`;
const work = hit.work, composer = hit.composer;
return JSON.stringify({
  kind: "choices",
  question: `How would you rate ${composer.name} — ${work.title}?`,
  options: ["1","2","3","4","5","6","7","8","9","10"],
  context: { workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
             composerId: composer.id, genre: work.genre, popular: work.popular === "1",
             searchQuery: `${composer.name} ${work.title}` },
  hint: "Present these options to the user and wait for their pick, then record the rating.",
});
```

When the user answers with a score, record it with the rating script below —
but build both entries from `context` and SKIP the Open Opus re-lookup.

### Several works match — "the Brahms serenade", "a Bach partita"

When `omnisearch` returns more than one plausible work and the user's words
don't settle it (opus number, key, nickname, instrument):

```js
const res = await gateway.openopus.omnisearch({ query: "Brahms Serenade", offset: 0 });
const hits = (res.results || []).filter((r) => r.work && r.work.id).slice(0, 5);
if (hits.length > 1) return JSON.stringify({
  kind: "choices",
  question: `Which work do you mean?`,
  options: hits.map((r) => `${r.composer.name} — ${r.work.title}${r.work.subtitle ? " (" + r.work.subtitle + ")" : ""}`),
  context: { candidates: hits.map((r) => ({ workId: r.work.id, title: r.work.title, subtitle: r.work.subtitle,
                                            composer: r.composer.name, composerId: r.composer.id,
                                            genre: r.work.genre, popular: r.work.popular === "1" })) },
  hint: "Present these options to the user and wait for their pick, then continue with that work's workId.",
});
```

Then continue the original request (lookup, recording, score, rating) with the
chosen candidate from `context` — no re-lookup.

## "I gave X a 9" — record a rating

A rating belongs to a PERSON. For the current user, resolve their own id and build the
rater-inclusive identity key. Run as one `execute_javascript` and reply with **exactly the
string it returns**. (If the user named a work but gave NO score, do not run this yet —
see "Asking the user to choose" above.)

```js
const userWork = "Brahms Symphony 4", rating = 9;   // whole number 1–10
const res = await gateway.openopus.omnisearch({ query: userWork, offset: 0 });
const hit = (res.results || []).find((r) => r.work && r.work.id);
if (!hit) return `No work matching "${userWork}" on Open Opus — confirm the composer and title.`;
const work = hit.work, composer = hit.composer, searchQuery = `${composer.name} ${work.title}`;
// The rater is the current user (also a Person node). ratingKey = "<myId>::<workId>".
const meRows = await gateway.kg.query({ cypher: "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1", params: JSON.stringify({}) });
const me = ((meRows && meRows.rows) ? meRows.rows[0] : (meRows && meRows[0])) || {};
await gateway.repository.createEntry({ type: "MusicalWork", data: {
  workId: work.id, title: work.title, subtitle: work.subtitle, composer: composer.name,
  composerId: composer.id, genre: work.genre, popular: work.popular === "1", searchQuery } });
await gateway.repository.createEntry({ type: "MusicalWorkRating",
  data: { ratingKey: `${me.id}::${work.id}`, raterId: me.id, raterName: me.name,
          workId: work.id, title: work.title, composer: composer.name, rating },   // add notes/heardOn if given
  relations: [{ predicate: "OF", to: { type: "MusicalWork", workId: work.id } }] });
return `Saved ${composer.name} — ${work.title} — ${rating}/10.`;
```

Ratings are whole numbers 1–10 (round a half and confirm). The `(me)-[:RATED]->(MusicalWorkRating)`
edge is added automatically for the current user — don't add it.

**Recording a rating for SOMEONE ELSE** ("Ada gave Brahms 4 a 9"): the data model supports it —
`MusicalWorkRating` carries `raterId`/`raterName` and hangs off any `Person` by
`(Person)-[:RATED]->(rating)`, so cross-person views work. But `create_entry` only auto-anchors the
CURRENT user (and its `relations` create outgoing edges only), so it can't yet build the
`(otherPerson)-[:RATED]->` edge. Until the host adds an anchor-on-person path, attributing a rating
to another person is a **seeding** operation, not a chat one — tell the user that plainly rather than
recording it under their own name.

## "What have I rated?" / "What did I think of X?"

Read ratings through VIRTUAL CYPHER, never `listEntries` — the scope rewriter
binds `(me:AssistantUser)` to the current user, and the `RATED` edge is the
attribution truth even for rows recorded before `raterName` existed:

```js
const rows = await gateway.kg.query({
  cypher: `MATCH (me:AssistantUser)-[:RATED]->(r:MusicalWorkRating)
           RETURN r.title AS title, r.composer AS composer, r.rating AS rating, r.notes AS notes
           ORDER BY r.rating DESC, r.title ASC`,
  params: JSON.stringify({}),
});
```

Filter by title/composer in the Cypher (`WHERE r.title CONTAINS '…'`) or in JS.
Report the score and quote any `notes` verbatim. If nothing matches, say so
plainly — never invent a rating. For SOMEONE ELSE's ratings, anchor on the
person instead: `MATCH (p:Person)-[:RATED]->(r:MusicalWorkRating) WHERE p.name
CONTAINS '<name>'`. Multi-person questions ("who rated what", "what would we
both enjoy", "where do we disagree") have saved views — `view_run`
`RatingsByRater`, `MutualFavourites`, or `DividedOpinions`. For other cross-cuts
(highest-rated chamber works, loved-and-hearable), the canonical shape is
`(User)-[:RATED]->(r:MusicalWorkRating)-[:OF]->(w:MusicalWork)`.

## Always

- **Warn the user BEFORE a slow call.** Generation — `SIMILAR_TO`/`SUGGESTS`, the
  recommendation views — takes up to a minute or two on a cold cache. Say so first
  ("this takes a minute — generating picks and finding recordings"), then run it.
  Fast (no warning needed): Open Opus lookups, rating reads/writes, titles-only
  views, and the direct IMSLP/recording searches (~1s per work).
- **Never fabricate** an Open Opus id, opus number, recording, score, or rating —
  each comes from a real `openopus` / web-grounded search call.
- For work FACTS, `openopus` is authoritative — prefer it over web search.
- Use the `maestro` voice only for recommendation / programme-note write-ups; stay
  in the default voice for facts, status, and clarifications.

## Discovery for someone with no history — start here

Every recommendation surface above anchors on a work the listener already rated 8+, so for a new
listener they are all empty and the honest answer used to be "go and rate ten works first". That is
advice, not help. Three paths need no history at all, and they are the right first move for anyone
who cannot already name what they want.

| Ask | View | Cost |
|---|---|---|
| "something for a wet Tuesday, nothing famous" | `SomethingToHearFast` (titles) / `SomethingToHear` (with a recording) | a generation, ~10–20s |
| "I think I like old music" | `ComposersOfEra` — the catalogue's composers for a period, with portraits and dates | ONE http call, no model |
| "who is this Rameau, where do I start" | `MeetAComposerFast` (titles) / `MeetAComposer` (with a recording) | ONE http call, no model |
| "where did Brahms come from" | `ComposerLineage` — who he is held to have learned from | a generation |

`SomethingToHear*` takes the listener's words VERBATIM as the `ask` parameter. Do not tidy them into
keywords: "forty minutes, nothing soothing" is the key, and the generator is written to honour an
appetite for difficulty rather than soften it.

**`PeriodInstruments` is computed, not guessed.** Every composer row carries it, true when the
composer died before 1850. When it is true, say that a period-instrument performance is closer to what
was written and what the listener will hear differently. Never work this out from a date yourself —
the column is there precisely because that judgement was got wrong in both directions.

A composer's `ComposerId` from `ComposersOfEra` is what `MeetAComposer*` takes. Starting from a NAME
instead, resolve it with `gateway.openopus.omnisearch` first — there are twenty Bachs.

## Keeping the listening record — DO THIS, don't just mean to

A guide that writes nothing down offers the same piece again next week. Four verbs, and they are
cheap: call them AS the conversation happens, in the same turn, without making a performance of it.
Never ask permission to note what somebody just told you; just note it and carry on.

| When they say | Call |
|---|---|
| anything after you offered a work, or they pressed play | `gateway.impromptu.recordListen({ workId, title, composer, url?, performance?, finished? })` |
| "I loved it", "that was a 7", any verdict | `gateway.impromptu.rateWork({ workId, rating, title, composer, composerId?, genre?, notes? })` |
| "I can't stand solo piano", "period instruments or nothing", "I've never tried Baroque" | `gateway.impromptu.recordTaste({ kind, value, stance, because })` |
| they reveal how much they know, or how hard they want pushing | `gateway.impromptu.recordListenerLevel({ knowledge, challenge, challengeNote })` |

`stance` is exactly one of `loves`, `likes`, `curious`, `avoids`, `hates` — anything else is refused.
`curious` is the most valuable of the five: it is the dimension to push on next, and the one a
listener mentions once and never repeats.

`kind` is the DIMENSION: `composer`, `era`, `genre`, `form`, `instrument`, `practice`, `mood`,
`language`, `length`. "I can't stand solo piano" is `{ kind: 'instrument', value: 'solo piano',
stance: 'hates' }` — and note what that boundary actually covers. It is about one instrument alone
carrying a whole work, so solo harpsichord, solo organ and solo lute are all inside it even though
none of them is a piano. Read a stated boundary for what the listener meant, not for its literal
noun; offering a harpsichord suite to somebody who just said that is the kind of answer that teaches
them you were not listening.

`recordListenerLevel` is the one to be careful with. Move `knowledge` on EVIDENCE — a named form, a
performer, an edition — never on self-deprecation, and never on enthusiasm. Omit a field to leave the
stored value alone; passing a default would quietly reset a returning listener to the middle.

Read it all back with `MyListening`, `MyMusicalStances` and `WhatIHaveHeard`.

## Recordings: never invent a link

Each of those links must come from a search you have just run (`gateway.brave.webSearch` with
`site:youtube.com/watch`, or the `HAS_RECORDING` join). Asked for something to hear with no search
run, a model will produce three confident `youtube.com/watch?v=…` addresses that do not exist — it
happened in testing, and a fabricated watch link is indistinguishable from a real one until the
listener clicks it.

So: if no search has run, NAME the performance in words — the ensemble, the soloist, roughly when it
was made — and let the surface attach the link. Naming the Arditti Quartet is useful and true;
inventing the URL of their recording is not.

## In conversation: name performances, never write a URL

The link guard in `askMaestro` strips any address the verb did not supply, so the VERB cannot
fabricate one. A chat conversation has no such guard — the host assembles the reply and the realm
never sees it — and a model that has not run a search will invent an address that looks exactly like
a real one. Observed, in replies that were otherwise good: `watch?v=Q6v6q6v6q6v` and
`watch?v=shostakovich-string-quartet-8`.

So in chat, give the PERFORMERS, not the URL: "the Borodin Quartet's later cycle", "Quatuor Arod,
2023". That is something the model actually knows, it survives a dead link, and it is what somebody
needs to type into a search. Surfaces attach real links themselves from `HAS_RECORDING` or a direct
`gateway.brave.webSearch`.

If a conversation genuinely needs a link, run the search first with `gateway.brave.webSearch` and
quote what comes back — never assemble one from a title.
