"use strict";
/**
 * Pure, deterministic helpers for the concert-programme lens
 * (lenses/concert-program.yml).
 *
 * The lens is a self-contained cypherscript and CANNOT import modules, so it
 * inlines byte-faithful copies of these functions. THIS module is the source of
 * truth and is unit-tested in tests/program.test.ts — keep the inline copies in
 * the lens in sync when either changes.
 *
 * Division of labour: the LLM owns the AESTHETIC arrangement (which works, in
 * what order, where the climax falls); this code owns the ARITHMETIC — parsing
 * the reply safely and enforcing the running-time budget — the part the model is
 * unreliable at.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArrangement = parseArrangement;
exports.fitToBudget = fitToBudget;
/**
 * Parse the arrangement LLM's reply into a validated {@link Arrangement}: strips
 * code fences, tolerates a non-JSON reply (→ empty), and drops any piece whose
 * `n` is out of range or duplicated so the caller can always trust `n` indexes a
 * real pool entry exactly once.
 */
function parseArrangement(text, poolSize) {
    const cleaned = String(text ?? "")
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
    let obj = null;
    try {
        obj = JSON.parse(cleaned);
    }
    catch {
        obj = null;
    }
    const raw = obj && Array.isArray(obj.pieces) ? obj.pieces : [];
    const seen = new Set();
    const pieces = [];
    for (const p of raw) {
        const n = Math.round(Number(p?.n));
        if (!Number.isFinite(n) || n < 1 || n > poolSize || seen.has(n))
            continue;
        seen.add(n);
        pieces.push({
            n,
            minutes: Math.max(1, Math.round(Number(p?.minutes) || 0)),
            role: String(p?.role ?? ""),
            note: String(p?.note ?? ""),
        });
    }
    return { title: obj && obj.title ? String(obj.title) : "", pieces };
}
const durationOf = (ps) => ps.reduce((sum, p) => sum + p.minutes, 0);
/** The arc's endpoints — never trimmed, so the programme keeps its shape. */
const isAnchor = (p) => /finale|opener/i.test(p.role);
/**
 * Enforce the time budget deterministically. While the programme runs more than
 * 15% over `targetMinutes` and has more than two works, drop the LAST non-anchor
 * (non-opener, non-finale) work — preserving the opener and the climactic finale
 * the LLM chose. Returns what was kept, what was dropped, and the final running
 * time. Never pads a short programme (that would mean inventing works).
 */
function fitToBudget(pieces, targetMinutes) {
    const ceiling = targetMinutes * 1.15;
    let kept = pieces.slice();
    const dropped = [];
    while (durationOf(kept) > ceiling && kept.length > 2) {
        let idx = -1;
        for (let i = kept.length - 1; i >= 0; i--) {
            if (!isAnchor(kept[i])) {
                idx = i;
                break;
            }
        }
        if (idx < 0)
            break; // only anchors left — stop rather than break the arc
        dropped.push(kept[idx]);
        kept = kept.slice(0, idx).concat(kept.slice(idx + 1));
    }
    return { kept, dropped, total: durationOf(kept) };
}
