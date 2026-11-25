"""The plumbing every check in tests/verify.py shares: the appliance, its auth, and the tally."""
# ---- the appliance, and how a check is counted -------------------------------------------------
import base64, json, os, re, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = (os.environ.get("APPLIANCE") or os.environ.get("APPLIANCE_URL") or "http://127.0.0.1:11043").rstrip("/")
_auth = os.environ.get("AUTH") or os.environ.get("EMBABEL_AUTH") or (
    f"{os.environ['EMBABEL_USER']}:{os.environ['EMBABEL_PASSWORD']}" if os.environ.get("EMBABEL_USER") else "")
if not _auth:
    sys.exit("set AUTH=user:pass (or EMBABEL_USER and EMBABEL_PASSWORD)")
HEADERS = {"Authorization": "Basic " + base64.b64encode(_auth.encode()).decode(), "Content-Type": "application/json"}
failures = 0


def _post(path, body, timeout=600):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return json.loads(text) | {"_http": e.code}
        except ValueError:
            return {"_http": e.code, "error": text[:300]}


def invoke(name, args=None):
    """A saved view BY NAME; the whole envelope (status, data, warnings, metrics)."""
    return _post(f"/api/v1/views/{name}/invoke", {"args": args or {}})


def kg(cypher, params=None):
    """Cypher over the world; rows plus the run's own source-call count (apiCalls)."""
    return _post("/api/v1/admin/kg/execute", {"cypher": cypher, **({"params": params} if params else {})})


def check(label, ok, detail=""):
    global failures
    failures += 0 if ok else 1
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(': ' + detail) if detail else ''}")
    return ok


# Warning codes on a query answer (/admin/kg/execute) that mean rows or values may be missing. A
# source that failed under load, a capped page or a cut traversal leaves rows that still look like
# an answer; read as one, the battery reports drift that is the source's, not the realm's. Cost
# notes (FILTERED_IN_GRAPH, AGGREGATE_NOT_PUSHED, EMPTY_NOT_KEPT, PUSHDOWN_VALUE_UNMATCHED), an
# honest FILTER_STARVED empty, STALE_COPY, FIELDS_WITHHELD and UNKNOWN_VIA leave every row in place.
SHORT_CODES = (
    "PARTIAL_RESULT", "PRODUCER_ERROR", "NEEDS_FILTER", "NEEDS_PRODUCER", "FILTER_REJECTED",
    "UNPUSHED_FILTER", "AMBIGUOUS_LABEL", "INCOMPLETE_TRAVERSAL", "INCOMPLETE_RANKING",
    "INCOMPLETE_AGGREGATE", "INCOMPLETE_INPUT", "MATERIALIZATION_FAILED", "REDUCTION_FAILED",
    "UNPARSEABLE_ANSWER", "TERMS_UNAVAILABLE", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
    "FOLLOW_CAPPED", "UNLINKED_CHILDREN", "RESOLUTION_DROPPED", "AGENTIC_DEGRADED",
    "SOURCE_UNANSWERED",
)
# The typed `reason` a query answer carries when it is neither clean nor an honest empty.
SHORT_REASONS = ("UNBOUNDED", "PARTIAL_NOT_MATCHED", "UNPUSHED_FILTER", "DISCONNECTED",
                 "INTERNAL_ERROR", "WRITE_IN_PROGRESS", "KILLED", "TOO_EXPENSIVE")
# The same, as a view envelope's public warning codes. A PARTIAL outcome is SUCCEEDED, so a
# status check alone counts its rows as the answer.
SHORT_PUBLIC = ("PARTIAL", "REDUCTION_FAILED", "COMPUTE_FAILED", "PROPERTY_NOT_STORED",
                "AGENTIC_DEGRADED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "SOURCE_REJECTED",
                "INVALID_FILTER", "UNPUSHED_FILTER", "TOO_BROAD", "FETCH_CAPPED",
                "INDEX_UNAVAILABLE", "ARGUMENT_REFUSED")


def short(d, figure=None):
    """None when the engine says this answer is whole; else the line a check prints in place of
    the figure: `REFUSED: <why>` (no answer) or `PARTIAL <figure>: <the engine's reason>`."""
    tag = "PARTIAL" if figure is None else f"PARTIAL {figure}"
    if not isinstance(d, dict):
        return "REFUSED: not an engine answer: " + str(d)[:160]
    if "outcome" in d or "status" in d:  # a view envelope
        if d.get("status") != "SUCCEEDED":
            err = d.get("error")
            msg = (f"{err.get('code', '')} {err.get('message', '')}".strip() if isinstance(err, dict) else str(err or ""))
            # The warnings name the source that failed and how; the message alone does not.
            why = "; ".join(str(w.get("message") or w.get("code") or w)[:240] if isinstance(w, dict) else str(w)[:240]
                            for w in d.get("warnings") or [])
            return f"REFUSED: {d.get('status')} {msg[:200]}{(' | ' + why) if why else ''}".strip()
        ws = [w for w in d.get("warnings") or [] if isinstance(w, dict) and w.get("code") in SHORT_PUBLIC]
        if d.get("outcome") not in ("OK", "EMPTY") or ws:
            why = f"{ws[0]['code']}: {ws[0].get('message', '')}" if ws else f"outcome {d.get('outcome')}"
            return f"{tag}: {why[:200]}"
        return None
    if d.get("error"):
        return "REFUSED: " + str(d["error"])[:200]
    if d.get("run"):
        return f"{tag}: the run had not finished ({d['run']})"
    ws = [w for w in d.get("warnings") or [] if isinstance(w, str) and w.split(":", 1)[0].strip() in SHORT_CODES]
    if ws:
        return f"{tag}: {ws[0][:200]}"
    if d.get("reason") in SHORT_REASONS:
        return f"{tag}: reason {d['reason']}"
    return None


def problem(env, figure=None):
    """Why this answer (a view envelope or a query result) is not the whole truth, or None."""
    why = short(env, figure)
    if env.get("_http") if isinstance(env, dict) else False:
        return f"{env['_http']} {why or 'REFUSED'}"
    return why


def yaml_view_names():
    names = []
    for f in sorted((ROOT / "views").glob("*.yml")):
        names += re.findall(r"^- name:\s*['\"]?([A-Za-z0-9_]+)", f.read_text(), re.M)
    return names


NO_ANCHORS = "named none the source could be read by"


def sweep(names, may_be_empty=(), needs_companion=()):
    """L1: every view answers by name on its defaults. A view in `may_be_empty` must still SUCCEED;
    one in `needs_companion` reads another realm's labels, and is skipped, loudly, when that realm
    is not installed (the refusal names the label) — and checked like any other when it is."""
    print(f"== L1: every view, by name, on its defaults ({len(names)})")
    for name in names:
        t0 = time.time()
        env = invoke(name)
        ms = int((time.time() - t0) * 1000)
        rows = len(env.get("data") or [])
        bad = problem(env, rows)
        if bad and name in needs_companion and re.search(r"(?i)label|undeclared|unknown|not installed", bad):
            print(f"  SKIP {name}: needs {needs_companion[name]} installed ({bad[:120]})")
            continue
        if bad and name in may_be_empty and NO_ANCHORS in bad:
            # A view that starts from records this world stores (ratings, birth records) and finds
            # none is refused rather than answered empty: there is nothing to read the source by.
            # On a fresh world that IS the answer, so it counts, and says so.
            check(f"{name}", True, f"refused for want of stored records, as a fresh world must ({ms}ms)")
        elif bad:
            check(f"{name}", False, bad)
        elif rows == 0 and name not in may_be_empty:
            check(f"{name}", False, f"no rows with its defaults ({ms}ms)")
        else:
            check(f"{name}", True, f"{rows} rows, {ms}ms" + ("" if rows else " (empty is right here)"))


def finish():
    if failures:
        print(f"{failures} CHECK(S) FAILED")
        sys.exit(1)
    print("ALL CHECKS PASS")
