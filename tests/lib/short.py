"""
Whether an engine answer is the whole truth, for a realm battery that reads a figure off it.

Three answer shapes reach a battery:

  query    /api/v1/admin/kg/execute and /api/v1/admin/kg/ask: `rows`, `error`, a typed `reason`,
           `answerBoundary`, an unfinished `run`, and `warnings` as strings that open with the
           engine's code ("PARTIAL_RESULT: ...").
  tool     /api/v1/tools/kg_ask and kg_query (the same answer as MCP tools give it): the query
           fields plus `incomplete`, a ready-made line present only on an incomplete read, and
           `emptyCause`, which is SOURCE_UNANSWERED when an empty result is a fetch that failed.
  view     /api/v1/views/{name}/invoke: `status`, `outcome`, `data`, and `warnings` as
           {code, message}.

On any of them a source that failed under load, a capped page or a refused hop leaves a figure
SHORT while the rows still look like an answer. A battery that reads the figure and ignores the
rest reports drift that is not the realm's, or passes a check it never made.

    short(d, figure=None) -> None when the answer is whole, else the line to print in place of the
                             figure: "REFUSED: <why>" (no answer at all) or
                             "PARTIAL <figure>: <the engine's reason>".

Run as a script it reads one answer on stdin and prints its verdict, or the figure in column `n`
when it is whole, so a shell battery can use it without Python of its own:

    curl ... | python3 tests/lib/short.py        # 3358, or PARTIAL 200: PARTIAL_RESULT: ...

This file is copied into realms from embabel-worlds/realm-spec (battery/), and the copy is pinned
and checked there: see battery/README.md. Change it in realm-spec, not in a realm.
"""
import json
import sys

# Every warning code the engine writes on a query answer, decided: SHORT_CODES mean rows or values
# may be missing; WHOLE_CODES leave every row in place (cost notes, an honest empty, provenance,
# withheld fields, a dated copy, judgement and projection notes). battery/engine_codes.py fails
# when the engine emits a code that is in neither, so a new kind is a decision, never a default.
SHORT_CODES = frozenset((
    "PARTIAL_RESULT", "PRODUCER_ERROR", "NEEDS_FILTER", "NEEDS_PRODUCER", "FILTER_REJECTED",
    "UNPUSHED_FILTER", "AMBIGUOUS_LABEL", "INCOMPLETE_TRAVERSAL", "INCOMPLETE_RANKING",
    "INCOMPLETE_AGGREGATE", "INCOMPLETE_INPUT", "MATERIALIZATION_FAILED", "REDUCTION_FAILED",
    "UNPARSEABLE_ANSWER", "TERMS_UNAVAILABLE", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
    "FOLLOW_CAPPED", "UNLINKED_CHILDREN", "RESOLUTION_DROPPED", "AGENTIC_DEGRADED",
    "SOURCE_UNANSWERED",
))
WHOLE_CODES = frozenset((
    "FILTERED_IN_GRAPH", "EMPTY_NOT_KEPT", "AGGREGATE_NOT_PUSHED", "PUSHDOWN_VALUE_UNMATCHED",
    "FILTER_STARVED", "ORDER_NOT_HONOURED", "UNKNOWN_VIA", "FIELDS_WITHHELD", "STALE_COPY",
    "LENIENT_PIN", "AUDIT_TRAIL", "AI_TERMS", "JUDGED_ON_EXCERPT", "MODEL_SPEND",
    "PROJECTION_DECLINED", "PROJECTION_UNRESOLVED", "PROJECTION_AMBIGUOUS", "PROJECTION_INCOMPLETE",
    "PROJECTION_INVALID", "PROJECTION_EMPTY",
))
# The typed `reason` a query answer carries when it is neither a clean answer nor an honest empty.
# NOT_IN_GRAPH, MISSING_ATTRIBUTE and FETCHED_NOT_MATCHED are honest: the read was complete.
SHORT_REASONS = frozenset(("UNBOUNDED", "PARTIAL_NOT_MATCHED", "UNPUSHED_FILTER", "DISCONNECTED",
                           "INTERNAL_ERROR", "WRITE_IN_PROGRESS", "KILLED", "TOO_EXPENSIVE"))
# Public warning codes on a view envelope that mean the same. A view whose outcome is not OK or
# EMPTY is short whatever its warnings say.
SHORT_PUBLIC = frozenset(("PARTIAL", "REDUCTION_FAILED", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
                          "AGENTIC_DEGRADED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "SOURCE_REJECTED",
                          "INVALID_FILTER", "UNPUSHED_FILTER", "TOO_BROAD", "FETCH_CAPPED",
                          "INDEX_UNAVAILABLE", "ARGUMENT_REFUSED"))


def code_of(warning):
    """The engine code a query warning opens with: the text before its first colon."""
    return warning.split(":", 1)[0].strip() if isinstance(warning, str) else None


def short(d, figure=None):
    tag = "PARTIAL" if figure is None else "PARTIAL %s" % (figure,)
    if not isinstance(d, dict):
        return "REFUSED: not an engine answer: " + str(d)[:160]
    if "outcome" in d or "status" in d:  # a view envelope
        if d.get("status") != "SUCCEEDED":
            err = d.get("error") or {}
            why = (err.get("code", "") + " " + err.get("message", "")).strip() if isinstance(err, dict) else str(err)
            return "REFUSED: %s %s" % (d.get("status"), why[:160])
        ws = [w for w in d.get("warnings") or [] if isinstance(w, dict) and w.get("code") in SHORT_PUBLIC]
        if d.get("outcome") not in ("OK", "EMPTY") or ws:
            why = ws[0]["code"] + ": " + ws[0].get("message", "") if ws else "outcome " + str(d.get("outcome"))
            return "%s: %s" % (tag, why[:200])
        return None
    if d.get("error"):
        return "REFUSED: " + str(d["error"])[:160]
    if d.get("run"):
        return "%s: the run had not finished (%s)" % (tag, json.dumps(d["run"], separators=(",", ":"))[:120])
    ws = [w for w in d.get("warnings") or [] if code_of(w) in SHORT_CODES]
    if ws:
        return "%s: %s" % (tag, ws[0][:200])
    if d.get("incomplete"):
        return "%s: %s" % (tag, str(d["incomplete"])[:200])
    if d.get("emptyCause") == "SOURCE_UNANSWERED":
        return "%s: emptyCause SOURCE_UNANSWERED" % tag
    if d.get("reason") in SHORT_REASONS:
        return "%s: reason %s" % (tag, d["reason"])
    if d.get("answerBoundary"):
        return "%s: the rows are supporting context, not an answer (answerBoundary)" % tag
    return None


def figure_of(d, column="n"):
    """The figure in `column` of the first row of a query answer, or a view's row count."""
    if isinstance(d, dict) and ("outcome" in d or "status" in d):
        data = d.get("data")
        return len(data) if isinstance(data, list) else 0
    rows = (d.get("rows") if isinstance(d, dict) else None) or []
    return rows[0].get(column) if rows else 0


# Only when run as the file itself: the same text is also run with `python3 -c "$SHORT_PY ..."` by
# short.sh and with exec() by batteries that embed it, and there __name__ is "__main__" too.
if __name__ == "__main__" and sys.argv[0].endswith("short.py"):
    answer = json.loads(sys.stdin.read(), strict=False)
    column = sys.argv[1] if len(sys.argv) > 1 else "n"
    value = figure_of(answer, column)
    print(short(answer, value) or value)
