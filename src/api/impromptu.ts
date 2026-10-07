/*
 * The realm's verbs: `gateway.impromptu.*`.
 *
 * Namespaced on the realm rather than on what the verbs do, because a manifest namespace is the
 * basename of this file and it is world-level. `gateway.catalogue.*` reads better right up to the
 * day a second realm wants a catalogue — the same reason every type here is `Musical*`.
 *
 * Two groups. FIRST, the Open Opus catalogue reshaped into what the graph declares: four verbs, each
 * also a producer (producers/impromptu.yml). They exist rather than pointing a raw remote producer at
 * the API because the catalogue's JSON and the realm's types disagree in three ways that every
 * reader would otherwise have to fix for itself:
 *
 *   - `complete_name` is not `completeName`, and a graph property named in snake case is a wart
 *     that spreads into every view and every app.
 *   - `/work/list/composer/{id}/genre/{genre}.json` carries the composer ONCE at the top level and
 *     not on each work, so `$.works[*]` cannot reach it — and a MusicalWork without `composer` has
 *     no `searchQuery`, which is the join key HAS_RECORDING needs. A JSONPath projection cannot
 *     join a record to its own parent; a verb can.
 *   - `prePiano` is a judgement about instruments that is DERIVED from a death year. Computing it
 *     once here, from the catalogue's own dates, is the difference between a fact and a guess: asked
 *     to work it out from a date in a prompt, a model put Mendelssohn on gut strings and Monteverdi
 *     on a Steinway.
 *
 * Every record carries the key it was fetched for, because that is how a virtual join links a
 * fetched record back to its anchor.
 *
 * SECOND, the listening record and the guide: what a person heard, what they think of a dimension of
 * music, and Maestro's turn. Those are at the bottom of the file.
 */
import type { GenericGatewayContext } from "@embabel/runtime-types";

/**
 * The year before which a period-instrument performance is closer to what was written. 1850 is a
 * convention and not a cliff — see `prePiano` in types/music.yml for what it actually claims.
 */
const PRE_PIANO_BEFORE = 1850;

/** One composer as the catalogue gives them. */
interface CatalogueComposer {
  id?: string;
  name?: string;
  complete_name?: string;
  epoch?: string;
  birth?: string;
  death?: string;
  portrait?: string;
}

/** One work as the catalogue gives it. */
interface CatalogueWork {
  id?: string;
  title?: string;
  subtitle?: string;
  genre?: string;
  popular?: string;
  recommended?: string;
}

interface ComposerListResponse {
  composers?: CatalogueComposer[] | null;
}

interface WorkListResponse {
  composer?: CatalogueComposer | null;
  works?: CatalogueWork[] | null;
}

interface OmnisearchResponse {
  results?: { composer?: CatalogueComposer | null; work?: CatalogueWork | null }[];
}

/** The slice of the gateway these verbs reach. */
interface CatalogueGateway {
  openopus: {
    omnisearch(a: { query: string; offset: number }): Promise<OmnisearchResponse>;
    composerByIds(a: { ids: string }): Promise<ComposerListResponse>;
    composersByEpoch(a: { epoch: string }): Promise<ComposerListResponse>;
    worksByGenre(a: { composerId: string; genre: string }): Promise<WorkListResponse>;
    popularComposers(a: Record<string, never>): Promise<ComposerListResponse>;
  };
}

/**
 * A composer, in the shape `MusicalComposer` declares. The echoed anchor key is a different property
 * per producer — a composer id for COMPOSED_BY, an era for HAS_COMPOSER, a name for INFLUENCED_BY —
 * so each verb sets its own, and the producer names it in `recordKeyField`.
 */
export interface ComposerRecord {
  composerId: string;
  name: string;
  completeName: string;
  epoch: string;
  birth: string;
  death: string;
  portrait: string;
  prePiano: boolean;
  /** Echoed anchor key for HAS_COMPOSER — the era this composer was listed under. */
  ofEra?: string;
  /** Echoed anchor key for INFLUENCED_BY — the composer this one is held to have influenced. */
  influenced?: string;
}

/** A work, in the shape `MusicalWork` declares, with `searchQuery` already assembled. */
export interface CatalogueWorkRecord {
  workId: string;
  title: string;
  subtitle: string;
  composer: string;
  composerId: string;
  genre: string;
  popular: boolean;
  searchQuery: string;
  /** Echoed anchor key for HAS_WORK — the composer whose list this work came from. */
  ofComposer?: string;
}

/** The year out of a catalogue date, which is `YYYY-MM-DD` with the month and day often invented. */
const yearOf = (date: string | undefined): number | null => {
  const m = /^(\d{4})/.exec((date ?? "").trim());
  return m ? Number(m[1]) : null;
};

/**
 * Whether this composer's music predates the modern orchestra. Keyed on DEATH, not birth: Beethoven
 * born in 1770 wrote the late quartets on instruments halfway to modern ones, and the question a
 * listener is really asking — "would a period band be closer to what was written?" — is about when
 * the music stopped being written, not when the composer started.
 *
 * A composer still living, or one with no recorded death, is not pre-modern.
 */
const prePianoFor = (c: CatalogueComposer): boolean => {
  const died = yearOf(c.death);
  return died !== null && died < PRE_PIANO_BEFORE;
};

const composerRecord = (c: CatalogueComposer): ComposerRecord => ({
  composerId: String(c.id ?? ""),
  name: c.name ?? "",
  completeName: c.complete_name ?? c.name ?? "",
  epoch: c.epoch ?? "",
  birth: c.birth ?? "",
  death: c.death ?? "",
  portrait: c.portrait ?? "",
  prePiano: prePianoFor(c),
});

/**
 * Composers by id — COMPOSED_BY. Batched: the catalogue's ids endpoint takes a comma-separated list,
 * so a page of forty works resolves its composers in one request rather than forty.
 *
 * A key that does not resolve is simply absent from the result, which is what a virtual join wants:
 * the work keeps its denormalised `composer` string and loses only the portrait.
 */
export async function findComposersByIds(
  ctx: GenericGatewayContext,
  args: { ids: string[] },
): Promise<ComposerRecord[]> {
  const ids = Array.from(new Set((args.ids ?? []).map((i) => String(i).trim()).filter(Boolean)));
  if (!ids.length) return [];
  const api = (ctx as unknown as CatalogueGateway).openopus;
  const res = await api.composerByIds({ ids: ids.join(",") });
  return (res.composers ?? []).filter((c) => c && c.id).map(composerRecord);
}

/**
 * One composer by name — the resolver behind INFLUENCED_BY. Per-key rather than batched, because
 * `omnisearch` is a free-text search and merging several names into one query returns a mess.
 *
 * Returns an ARRAY with at most one element, so the producer's `records: "$[*]"` reads it the same
 * way as the batched verbs: a name the catalogue does not know yields an empty list, and the
 * generated edge is dropped rather than pointing at a composer who does not exist.
 */
export async function findComposersByName(
  ctx: GenericGatewayContext,
  args: { name: string },
): Promise<ComposerRecord[]> {
  const name = (args.name ?? "").trim();
  if (!name) return [];
  const api = (ctx as unknown as CatalogueGateway).openopus;
  const res = await api.omnisearch({ query: name, offset: 0 });
  /*
   * The first hit whose composer the search actually matched. A work hit carries its composer too,
   * so this finds "Buxtehude" whether the catalogue answers with the man or with one of his works.
   */
  const hit = (res.results ?? []).find((r) => r.composer && r.composer.id);
  return hit && hit.composer ? [{ ...composerRecord(hit.composer), influenced: name }] : [];
}

/**
 * Every catalogued composer of a style period — HAS_COMPOSER, the browse path for "something
 * Baroque". Per-era calls, since the endpoint takes one era; eras are few and cached for a month.
 *
 * Ordered as the catalogue orders them, which is alphabetical and therefore puts Albinoni in front
 * of Bach. A surface that wants the famous ones first should say so in its own ORDER BY rather than
 * have this verb pretend to a judgement it is not making.
 */
export async function findComposersOfEra(
  ctx: GenericGatewayContext,
  args: { eras: string[] },
): Promise<ComposerRecord[]> {
  const eras = Array.from(new Set((args.eras ?? []).map((e) => String(e).trim()).filter(Boolean)));
  if (!eras.length) return [];
  const api = (ctx as unknown as CatalogueGateway).openopus;
  const out: ComposerRecord[] = [];
  for (const era of eras) {
    const res = await api.composersByEpoch({ epoch: era });
    for (const c of res.composers ?? []) {
      if (c && c.id) out.push({ ...composerRecord(c), ofEra: era });
    }
  }
  return out;
}

/**
 * The widening chain for a composer nobody has curated. `Popular` is the catalogue's own shortlist,
 * `Recommended` its narrower one, and `all` is every work it holds.
 *
 * This exists because `Popular` is sparse in a way the catalogue does not advertise: Rameau, with 57
 * works catalogued, has NONE marked popular, so the browse path dead-ended on a composer the
 * catalogue knows perfectly well — and the response for an empty genre is `success: "false"`, not an
 * empty list, so it looked like a failure rather than a gap. Exactly the composers worth meeting are
 * the ones nobody has shortlisted.
 */
const WIDENING = ["Popular", "Recommended", "all"] as const;

/**
 * A composer's works — HAS_WORK. With no `genre`, this walks the widening chain until the catalogue
 * has something: the set to choose FROM, not an instruction to play the first one.
 *
 * With an EXPLICIT `genre` it asks for that and only that. A caller who says "Chamber" and gets the
 * opera back has been given the answer to a different question, and widening past a filter somebody
 * supplied is the one kind of helpfulness that is simply wrong.
 *
 * This is the verb that cannot be a raw remote producer: `searchQuery` is `<composer> <title>`, and
 * the composer lives at the top of the response while the works live in an array beside it.
 */
export async function findWorksOfComposer(
  ctx: GenericGatewayContext,
  args: { composerIds: string[]; genre?: string },
): Promise<CatalogueWorkRecord[]> {
  const ids = Array.from(new Set((args.composerIds ?? []).map((i) => String(i).trim()).filter(Boolean)));
  if (!ids.length) return [];
  const asked = (args.genre ?? "").trim();
  const chain: readonly string[] = asked ? [asked] : WIDENING;
  const api = (ctx as unknown as CatalogueGateway).openopus;
  const out: CatalogueWorkRecord[] = [];
  for (const composerId of ids) {
    for (const genre of chain) {
      const res = await api.worksByGenre({ composerId, genre });
      const composer = res.composer?.name ?? "";
      const works = (res.works ?? []).filter((w) => w && w.id);
      for (const w of works) {
        const title = w.title ?? "";
        out.push({
          workId: String(w.id),
          title,
          subtitle: w.subtitle ?? "",
          composer,
          composerId,
          genre: w.genre ?? "",
          popular: w.popular === "1",
          /* The join key for HAS_RECORDING. Composer first, because a bare title is ambiguous. */
          searchQuery: [composer, title].filter(Boolean).join(" "),
          ofComposer: composerId,
        });
      }
      /* Stop at the first rung that has anything: widen to find works, never to pad them. */
      if (works.length) break;
    }
  }
  return out;
}

/**
 * The catalogue's own most-performed composers — the answer to "where do I even start" that needs
 * no era, no name and no history. Not a producer: there is no anchor to hang it on, and a surface
 * that wants a starting point calls it directly.
 */
export async function popularComposers(
  ctx: GenericGatewayContext,
  _args: Record<string, never>,
): Promise<ComposerRecord[]> {
  const api = (ctx as unknown as CatalogueGateway).openopus;
  const res = await api.popularComposers({});
  return (res.composers ?? []).filter((c) => c && c.id).map(composerRecord);
}

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * The listening record, and the guide.
 *
 * Four writes and one reading. The writes exist as NAMED VERBS rather than as `gateway.repository`
 * calls from the agent because an agent's `authority` grants verbs, one at a time, and "Maestro may
 * record that you heard something" is a grant an operator can read and reason about. `builtins:
 * [data]` would be a licence to create any entry of any type, which is not what this agent needs and
 * not what anyone would knowingly sign.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

import { personaBySlug, personaSlugs, type PersonaBrief } from "../generated/personas.js";

/** The person a write is attributed to. Their AssistantUser node also carries `Person`. */
interface CurrentPerson {
  id?: string;
  name?: string;
}

interface StoreGateway {
  repository: {
    createEntry(a: { type: string; data: Record<string, unknown>; relations?: unknown[] }): Promise<{ id: string }>;
  };
  kg: { query(a: { cypher: string; params: string }): Promise<{ rows?: unknown[] } | unknown[]> };
}

interface AiGateway {
  ai: { complete(a: { prompt: string; role?: string; skills?: string[] }): Promise<unknown> };
}

/** Rows out of the graph, whichever of the two shapes the gateway returns them in. */
const rowsOf = <T>(res: { rows?: T[] } | T[] | null | undefined): T[] => {
  if (!res) return [];
  return Array.isArray(res) ? res : (res.rows ?? []);
};

const queryRows = async <T>(ctx: GenericGatewayContext, cypher: string, params: Record<string, unknown> = {}): Promise<T[]> => {
  const res = await (ctx as unknown as StoreGateway).kg.query({ cypher, params: JSON.stringify(params) });
  return rowsOf(res as { rows?: T[] } | T[]);
};

/** The current user's own Person id and name, from the scoped graph. */
const currentPerson = async (ctx: GenericGatewayContext): Promise<CurrentPerson> => {
  const rows = await queryRows<CurrentPerson>(
    ctx,
    "MATCH (me:AssistantUser) RETURN me.id AS id, me.name AS name LIMIT 1",
  );
  return rows[0] ?? {};
};

const nowIso = (): string => new Date().toISOString();

/** A whole number in range, or null — a rating outside 1-10 is a caller bug, not something to clamp. */
const wholeInRange = (v: unknown, lo: number, hi: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export interface WriteResult {
  id: string;
  /** What was written, in a form a guide can repeat back without a second lookup. */
  recorded: string;
}

/**
 * Record that a person HEARD a work. The event, not the opinion — see MusicalListen in
 * types/music.yml for why the two are separate types.
 *
 * `heardAt` is part of the identity key, so hearing the same work twice is two events. That is
 * deliberate: a listening history that upserted would report a listener who returns to a piece
 * weekly identically to one who heard it once and never again, and those are opposite facts.
 */
export async function recordListen(
  ctx: GenericGatewayContext,
  args: {
    workId: string;
    title?: string;
    composer?: string;
    url?: string;
    performance?: string;
    source?: string;
    finished?: boolean;
  },
): Promise<WriteResult> {
  const workId = String(args.workId ?? "").trim();
  if (!workId) throw new Error("recordListen needs a workId — the Open Opus id of the work heard.");
  const me = await currentPerson(ctx);
  const heardAt = nowIso();
  const data = {
    listenKey: `${me.id ?? ""}::${workId}::${heardAt}`,
    listenerId: me.id ?? "",
    workId,
    title: args.title ?? "",
    composer: args.composer ?? "",
    heardAt,
    url: args.url ?? "",
    performance: args.performance ?? "",
    source: args.source ?? "chat",
    finished: args.finished === true,
  };
  const entry = await (ctx as unknown as StoreGateway).repository.createEntry({ type: "MusicalListen", data });
  return {
    id: entry.id,
    recorded: `heard ${[args.composer, args.title].filter(Boolean).join(" — ") || workId}`,
  };
}

/**
 * Record what a person thought of a work, 1-10. The same write `MusicalWork.rate` makes, exposed as a
 * namespace verb so an agent can be granted it by name without being granted entry creation at large.
 *
 * Writes the MusicalWork too, so a rating always has a work to join to: a rating whose work was never
 * created is a row the recommendation anti-join cannot see.
 */
export async function rateWork(
  ctx: GenericGatewayContext,
  args: {
    workId: string;
    rating: number;
    title?: string;
    composer?: string;
    composerId?: string;
    genre?: string;
    searchQuery?: string;
    notes?: string;
    heardOn?: string;
  },
): Promise<WriteResult> {
  const workId = String(args.workId ?? "").trim();
  if (!workId) throw new Error("rateWork needs a workId — the Open Opus id of the work.");
  const rating = wholeInRange(args.rating, 1, 10);
  if (rating === null) throw new Error(`A rating is a whole number from 1 to 10; got ${JSON.stringify(args.rating)}.`);
  const me = await currentPerson(ctx);
  const store = (ctx as unknown as StoreGateway).repository;
  const title = args.title ?? "";
  const composer = args.composer ?? "";
  await store.createEntry({
    type: "MusicalWork",
    data: {
      workId,
      title,
      composer,
      composerId: args.composerId ?? "",
      genre: args.genre ?? "",
      searchQuery: args.searchQuery || [composer, title].filter(Boolean).join(" "),
    },
  });
  const entry = await store.createEntry({
    type: "MusicalWorkRating",
    data: {
      ratingKey: `${me.id ?? ""}::${workId}`,
      raterId: me.id ?? "",
      raterName: me.name ?? "",
      workId,
      title,
      composer,
      rating,
      notes: args.notes ?? "",
      heardOn: args.heardOn ?? nowIso().slice(0, 10),
    },
    relations: [{ predicate: "OF", to: { type: "MusicalWork", workId } }],
  });
  return { id: entry.id, recorded: `${[composer, title].filter(Boolean).join(" — ") || workId} — ${rating}/10` };
}

/** The stances a listener can take on a dimension. Anything else is refused rather than stored loosely. */
const STANCES = ["loves", "likes", "curious", "avoids", "hates"] as const;

/**
 * Record a stance on a DIMENSION of music — "no solo piano", "period instruments or nothing". This is
 * what a rating cannot express and a proposition cannot be anti-joined on.
 *
 * `kind` is left open rather than enumerated: the dimensions people actually state are not a closed
 * set, and a stance stored under an unexpected kind is still readable, where a refused write is lost.
 * `stance` IS closed, because the recommendation queries filter on it and a free-text stance would
 * silently drop out of every one of them.
 */
export async function recordTaste(
  ctx: GenericGatewayContext,
  args: { kind: string; value: string; stance: string; because?: string },
): Promise<WriteResult> {
  const kind = String(args.kind ?? "").trim().toLowerCase();
  const value = String(args.value ?? "").trim();
  const stance = String(args.stance ?? "").trim().toLowerCase();
  if (!kind || !value) throw new Error("recordTaste needs a kind (e.g. 'instrument') and a value (e.g. 'solo piano').");
  if (!(STANCES as readonly string[]).includes(stance)) {
    throw new Error(`stance must be one of ${STANCES.join(", ")}; got ${JSON.stringify(args.stance)}.`);
  }
  const me = await currentPerson(ctx);
  const entry = await (ctx as unknown as StoreGateway).repository.createEntry({
    type: "MusicalTaste",
    data: {
      tasteKey: `${me.id ?? ""}::${kind}::${value.toLowerCase()}`,
      personId: me.id ?? "",
      kind,
      value,
      stance,
      because: args.because ?? "",
      statedAt: nowIso().slice(0, 10),
    },
  });
  return { id: entry.id, recorded: `${stance} ${value} (${kind})` };
}

/**
 * Revise how much a listener knows and how hard they want to be pushed. One node per person, updated
 * in place — the durable form of the two notebook slots that steer every recommendation.
 *
 * Both fields are optional so a turn can move one without asserting the other; an omitted field
 * leaves the stored value alone rather than resetting it to a default, which is the bug that would
 * quietly return every returning listener to the middle of the scale.
 */
export async function recordListenerLevel(
  ctx: GenericGatewayContext,
  args: { knowledge?: string; challenge?: number; challengeNote?: string },
): Promise<WriteResult> {
  const me = await currentPerson(ctx);
  const existing = (
    await queryRows<{ knowledge?: string; challenge?: number; challengeNote?: string }>(
      ctx,
      `MATCH (me:AssistantUser)-[:LISTENS_AS]->(l:MusicalListener)
       RETURN l.knowledge AS knowledge, l.challenge AS challenge, l.challengeNote AS challengeNote LIMIT 1`,
    )
  )[0] ?? {};
  const knowledge = (args.knowledge ?? "").trim() || existing.knowledge || "casual";
  const challenge = wholeInRange(args.challenge, 1, 10) ?? wholeInRange(existing.challenge, 1, 10) ?? 4;
  const entry = await (ctx as unknown as StoreGateway).repository.createEntry({
    type: "MusicalListener",
    data: {
      listenerKey: me.id ?? "",
      personId: me.id ?? "",
      knowledge,
      challenge,
      challengeNote: (args.challengeNote ?? "").trim() || existing.challengeNote || "",
      updatedAt: nowIso(),
    },
  });
  return { id: entry.id, recorded: `${knowledge}, challenge ${challenge}/10` };
}

/* ── The guide's turn ───────────────────────────────────────────────────────────────────────── */

/** One work the surface has in front of the listener, so the reply is about what they can see. */
export interface WorkInView {
  workId?: string;
  title?: string;
  composer?: string;
  composerId?: string;
  genre?: string;
  /** The recording on offer, where the surface has one. */
  url?: string;
  performance?: string;
}

export interface GuideAnswer {
  guide: string;
  guideName: string;
  question: string;
  answer: string;
  /** What the turn was grounded in, so a caller can show its working rather than trusting it. */
  grounding: {
    ratings: number;
    listens: number;
    stances: number;
    worksInView: number;
    knowledge: string;
    challenge: number;
    prePiano: string[];
    /** Links the guide invented and this verb removed. Should be 0; a rising number is a regression. */
    strippedLinks: number;
  };
  conversation: string | null;
}

const MAX_QUESTION = 2000;

/** A turn of the conversation as a client holds it. */
interface Turn {
  role?: string;
  text?: string;
}

/**
 * Strip every markdown link whose URL was not handed to the model, leaving its text behind.
 *
 * This is a GUARANTEE rather than an instruction, and it exists because the instruction did not hold.
 * Asked for something to hear next, with no URL anywhere in its prompt and an explicit rule not to
 * invent one, the model returned three confident `youtube.com/watch?v=…` links it had made up — and
 * opened by narrating a search it had not run. A fabricated watch link is the worst output this realm
 * can produce: it looks exactly like a real one, it is the thing the listener clicks first, and the
 * realm's whole claim is that what it tells you is grounded.
 *
 * So the prose is filtered after the fact against the set of URLs that actually came from a search.
 * The link text survives as plain text — "the Arditti Quartet" is still useful to read and still a
 * true thing to say — and the surface attaches a real link of its own.
 */
export const stripUngroundedLinks = (
  markdown: string,
  allowed: Iterable<string>,
): { text: string; stripped: string[] } => {
  const ok = new Set(Array.from(allowed).filter(Boolean));
  const stripped: string[] = [];
  const text = String(markdown || "").replace(
    /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (whole, label: string, url: string) => {
      if (ok.has(url)) return whole;
      stripped.push(url);
      /* Keep the words, drop the false promise. A bare label reads as prose, which it is. */
      return label || "";
    },
  );
  return { text, stripped };
};

const transcript = (history: Turn[] | undefined): string =>
  (history ?? [])
    .slice(-10)
    .map((t) => `${(t.role ?? "").toLowerCase() === "assistant" ? "You" : "Them"}: ${(t.text ?? "").trim()}`)
    .filter((l) => l.length > 5)
    .join("\n\n");

/**
 * Ask a guide about music, grounded in what this listener has actually done.
 *
 * Everything factual is assembled HERE and handed over: their ratings, what they have been played,
 * the boundaries they have stated, where they have got to as a listener, the works the surface is
 * showing, and — computed, never inferred — which of those composers died before 1850. That last one
 * is the reason this verb exists rather than letting the model reason from a date: Maestro's third
 * position is to push period performance for pre-1850 music, and a model asked to work out which
 * music that is from memory puts Mendelssohn on gut strings.
 *
 * The persona arrives from the compiled brief, so the voice here and the voice in chat are the same
 * authored file. Its `objective` is withheld when the caller says the listener has asked to stop
 * being pushed — the same brake the host applies to the agent conversation, for the same reason.
 */
export async function askMaestro(
  ctx: GenericGatewayContext,
  args: {
    question: string;
    guide?: string;
    history?: Turn[];
    worksInView?: WorkInView[];
    /** True once the listener has asked not to be pushed. Suppresses the advocacy, never the help. */
    askedToStop?: boolean;
    conversation?: string;
    role?: string;
  },
): Promise<GuideAnswer> {
  const slug = (args.guide ?? "maestro").trim().toLowerCase();
  const who: PersonaBrief | undefined = personaBySlug(slug);
  if (!who) throw new Error(`No guide called '${slug}'. This realm ships: ${personaSlugs().join(", ")}.`);
  const question = (args.question ?? "").trim().slice(0, MAX_QUESTION);
  if (!question) throw new Error("No question asked.");

  /* What this listener has actually done. Four cheap reads over stored rows — no virtual joins, so
   * no generation and no web calls: a chat turn must not cost a minute before it starts. */
  const [listener, ratings, listens, stances] = await Promise.all([
    queryRows<{ knowledge?: string; challenge?: number; challengeNote?: string }>(
      ctx,
      `MATCH (me:AssistantUser)-[:LISTENS_AS]->(l:MusicalListener)
       RETURN l.knowledge AS knowledge, l.challenge AS challenge, l.challengeNote AS challengeNote LIMIT 1`,
    ),
    queryRows<{ composer?: string; title?: string; rating?: number; notes?: string }>(
      ctx,
      `MATCH (me:AssistantUser)-[:RATED]->(r:MusicalWorkRating)
       RETURN r.composer AS composer, r.title AS title, r.rating AS rating, r.notes AS notes
       ORDER BY r.rating DESC, r.title ASC LIMIT 40`,
    ),
    queryRows<{ composer?: string; title?: string; heardAt?: string; finished?: boolean }>(
      ctx,
      `MATCH (me:AssistantUser)-[:HEARD]->(l:MusicalListen)
       RETURN l.composer AS composer, l.title AS title, l.heardAt AS heardAt, l.finished AS finished
       ORDER BY l.heardAt DESC LIMIT 20`,
    ),
    queryRows<{ kind?: string; value?: string; stance?: string; because?: string }>(
      ctx,
      `MATCH (me:AssistantUser)-[:HAS_TASTE]->(t:MusicalTaste)
       RETURN t.kind AS kind, t.value AS value, t.stance AS stance, t.because AS because
       ORDER BY t.stance ASC, t.value ASC LIMIT 30`,
    ),
  ]);

  const level = listener[0] ?? {};
  const knowledge = (level.knowledge ?? "casual").trim();
  const challenge = wholeInRange(level.challenge, 1, 10) ?? 4;

  /* WHICH of the works on screen predate the modern orchestra — computed from the catalogue's own
   * death years, in one batched call, and handed over as a finding rather than a date to interpret. */
  const inView = (args.worksInView ?? []).filter((w) => w && (w.title || w.workId)).slice(0, 12);
  const composerIds = Array.from(new Set(inView.map((w) => String(w.composerId ?? "").trim()).filter(Boolean)));
  let prePianoNames: string[] = [];
  if (composerIds.length) {
    try {
      const composers = await findComposersByIds(ctx, { ids: composerIds });
      prePianoNames = composers.filter((c) => c.prePiano).map((c) => c.name).filter(Boolean);
    } catch {
      /* The catalogue being down is not a reason to refuse the turn. The guide then simply has no
       * period-performance finding to act on, which is better than one it guessed. */
      prePianoNames = [];
    }
  }

  const loved = ratings.filter((r) => Number(r.rating) >= 8);
  const disliked = ratings.filter((r) => Number(r.rating) <= 4);
  const avoided = stances.filter((s) => s.stance === "avoids" || s.stance === "hates");
  const curious = stances.filter((s) => s.stance === "curious");

  const list = (items: string[], empty: string): string => (items.length ? items.map((i) => `  - ${i}`).join("\n") : `  ${empty}`);

  const said = transcript(args.history);
  const stopped = args.askedToStop === true;

  const prompt = `${who.brief}
${who.objective && !stopped ? `\nWHAT YOU ARE TRYING TO ACHIEVE:\n${who.objective}\n` : ""}
WHO YOU ARE TALKING TO, from their own record in this world. Work from this and do not invent a
preference they have not stated.

  How much they know: ${knowledge}
  How hard they want to be pushed: ${challenge}/10${level.challengeNote ? ` — their words: "${level.challengeNote}"` : ""}

Works they LOVE (rated 8+), which is the strongest evidence you have about what to play next:
${list(loved.map((r) => `${r.composer ?? "?"} — ${r.title ?? "?"} (${r.rating}/10)${r.notes ? ` · "${r.notes}"` : ""}`), "nothing rated yet")}

Works they did NOT like (4 or less). Never offer these, and never offer a work as one they will love
when they scored it low:
${list(disliked.map((r) => `${r.composer ?? "?"} — ${r.title ?? "?"} (${r.rating}/10)${r.notes ? ` · "${r.notes}"` : ""}`), "nothing rated low")}

Boundaries they have STATED. These are settled; do not argue with them or work around them:
${list(avoided.map((s) => `${s.stance} ${s.value} (${s.kind})${s.because ? ` — "${s.because}"` : ""}`), "none stated")}

Dimensions they said they are CURIOUS about — the most useful thing on this page, and the first place
to push:
${list(curious.map((s) => `${s.value} (${s.kind})${s.because ? ` — "${s.because}"` : ""}`), "none stated")}

What they have already been played, most recent first. Do not offer these again as though they were
new; a work heard and NOT finished is a stronger signal than one never offered:
${list(listens.map((l) => `${l.composer ?? "?"} — ${l.title ?? "?"}${l.finished ? " (heard through)" : " (not finished)"}`), "nothing played yet")}

${inView.length ? `ON THEIR SCREEN RIGHT NOW. This is what "this piece" or "the second one" means:
${inView.map((w, i) => `  ${i + 1}. ${w.composer ?? "?"} — ${w.title ?? "?"}${w.genre ? ` (${w.genre})` : ""}${w.performance ? `\n     performance on offer: ${w.performance}` : ""}${w.url ? `\n     ${w.url}` : ""}`).join("\n")}
` : "Nothing is on their screen; this is a conversation rather than a reaction to a list.\n"}
${prePianoNames.length ? `COMPUTED, from the catalogue's death years — not your recollection: the music of ${prePianoNames.join(", ")} predates
the modern orchestra, so a period-instrument performance is closer to what was written. Your third
position applies to these and to no others on this page. Say what they will actually hear differently.
` : ""}
${said ? `The conversation so far:\n\n${said}\n` : ""}
Them: ${question}

Reply in your own voice, as markdown, in a few short paragraphs at most. No preamble.

Answer the question they actually asked, in the register they asked it in.

LINKS. ${inView.some((w) => w.url) ? `The ONLY web addresses that exist for you are the ones listed above under
what is on their screen. You may link those, exactly as written, with the performers as the link text.` : `NO web address has been given to you in this turn, so you have none to give.`}
You are not running a search and you cannot look anything up: this is one message, with the facts above
and nothing else. So for any OTHER recording you recommend, NAME it in plain words — the performers,
the ensemble, roughly when it was made — and do not write a link, a URL, a video id or "search for X on
YouTube" as though it were one. The surface the listener is reading attaches the real links itself, from
a real search, once it knows which performance you meant. A made-up address is the one failure here
that cannot be forgiven: it is indistinguishable from a real one until they click it. Naming the Arditti
Quartet is useful and true; inventing the URL of their recording is not.

Do not narrate work you are not doing. You are not "finding recordings" or "looking up" anything in
this reply, so do not say you are.
${stopped ? `
THEY HAVE ASKED YOU TO STOP PUSHING, earlier in this conversation. That is settled and it does not
expire. Give them exactly what they asked for and nothing else: no next step, no further suggestion,
no idea they did not ask for, and nothing slipped in after an acknowledgement. Stay warm. Before you
send it, check whether the reply contains a recommendation they did not ask for — if it does, cut it.
` : ""}`;

  const answer = await (ctx as unknown as AiGateway).ai.complete({
    prompt,
    skills: ["music"],
    ...(args.role ? { role: args.role } : {}),
  });

  /* Every URL the model was actually given. Anything else in the reply was invented. */
  const guarded = stripUngroundedLinks(
    (typeof answer === "string" ? answer : JSON.stringify(answer)).trim(),
    inView.map((w) => String(w.url ?? "")),
  );

  return {
    guide: who.slug,
    guideName: who.name,
    question,
    answer: guarded.text,
    grounding: {
      ratings: ratings.length,
      listens: listens.length,
      stances: stances.length,
      worksInView: inView.length,
      knowledge,
      challenge,
      prePiano: prePianoNames,
      /*
       * Surfaced rather than swallowed. A caller showing its working should be able to say that the
       * guide reached for a link it did not have, and a count that quietly stays above zero is how
       * anybody would notice the prompt above has stopped working.
       */
      strippedLinks: guarded.stripped.length,
    },
    conversation: args.conversation ?? null,
  };
}

export interface GuideRecord {
  slug: string;
  name: string;
  tagline: string;
  /** Carried as DATA so a surface does not have to hardcode which guide it opens on. */
  isDefault: boolean;
}

/** The guides this realm ships, for a picker that does not have to know their names in advance. */
export async function guides(
  _ctx: GenericGatewayContext,
  _args: Record<string, never>,
): Promise<GuideRecord[]> {
  return personaSlugs().map((slug) => {
    const p = personaBySlug(slug) as PersonaBrief;
    return { slug: p.slug, name: p.name, tagline: p.tagline, isDefault: p.slug === "maestro" };
  });
}
