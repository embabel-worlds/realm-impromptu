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


# Whether an answer is the whole truth is the engine's to say, beside the rows: the battery library
# (tests/lib, pinned from embabel-worlds/realm-spec) decides it, for query, tool and view answers alike.
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from short import short as _short  # noqa: E402


def short(d, figure=None):
    """None when the engine says this answer is whole; else the line a check prints in place of
    the figure: `REFUSED: <why>` (no answer) or `PARTIAL <figure>: <the engine's reason>`. A
    refused view also carries its warnings, which name the source that failed and how; the
    message alone does not."""
    why = _short(d, figure)
    if why and why.startswith("REFUSED") and isinstance(d, dict) and "status" in d:
        notes = "; ".join(str(w.get("message") or w.get("code") or w)[:240] if isinstance(w, dict) else str(w)[:240]
                          for w in d.get("warnings") or [])
        why += (" | " + notes) if notes else ""
    return why


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
