"""
The realm's battery, against a live appliance with realm-impromptu installed. Keyless: the ground
truth is the Open Opus catalogue, which is public.

    APPLIANCE=http://127.0.0.1:11043 AUTH=user:pass sh tests/verify.sh

  L1  every view answers BY NAME on its defaults. Views over the listener's own ratings, listens
      and stances must succeed and may be empty on a fresh world. The two views that attach a
      YouTube recording need the research realm's web search and a Brave key; without them they
      succeed empty, so they may be empty here, and their Fast twins (catalogue only) may not.
  L2  the catalogue reconciles: the Baroque composers and Brahms's chamber works are exactly the
      ones Open Opus lists, asked of it directly.
  L3  the genre pushdown: `WHERE w.genre = 'Chamber'` on HAS_WORK is asked of the catalogue, so,
      read fresh, the realm fetches exactly the chamber list — not the shortlist, filtered.
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from battery_common import check, finish, invoke, kg, problem, sweep, yaml_view_names  # noqa: E402

PERSONAL = {"MyMusicalStances", "WhatIHaveHeard", "WorkRecommendations", "TasteBasedRecommendations",
            "ChamberRecommendations", "WorksYoullProbablyDislike", "RatingsByRater", "MutualFavourites",
            "DividedOpinions"}
NEEDS_WEB_SEARCH = {"SomethingToHear", "MeetAComposer"}
sweep(yaml_view_names(), may_be_empty=PERSONAL | NEEDS_WEB_SEARCH)


def opus(path):
    return json.load(urllib.request.urlopen("https://api.openopus.org" + path, timeout=60))


print("== L2: the catalogue, against Open Opus asked directly")
want = sorted(str(c["id"]) for c in opus("/composer/list/epoch/Baroque.json").get("composers") or [])
env = invoke("ComposersOfEra", {"era": "Baroque"})
got = sorted(str(r["ComposerId"]) for r in env.get("data") or [])
check("ComposersOfEra(Baroque) = Open Opus's Baroque list", got == want and not problem(env),
      problem(env) or f"{len(got)} vs {len(want)}")

chamber = sorted(str(w["id"]) for w in opus("/work/list/composer/80/genre/Chamber.json").get("works") or [])
CYPHER = ("MATCH (c:MusicalComposer {{composerId: '80'}})-[:HAS_WORK{fresh}]->(w:MusicalWork) "
          "WHERE w.genre = 'Chamber' RETURN w.workId AS id")
res = kg(CYPHER.format(fresh=""))
got = sorted(str(r["id"]) for r in res.get("rows") or [])
check("Brahms's chamber works = Open Opus's chamber list", got == chamber, f"{len(got)} vs {len(chamber)}")

print("== L3: the genre is asked of the catalogue")
res = kg(CYPHER.format(fresh=" {ai: {fresh: true}}"))
fetched = res.get("fetchedRecords")
check("fresh: fetched exactly the chamber list", fetched == len(chamber),
      f"fetchedRecords={fetched}, chamber works={len(chamber)}, apiCalls={res.get('apiCalls')}")
check("fresh: one source call", res.get("apiCalls") is not None and res.get("apiCalls") <= 1, f"apiCalls={res.get('apiCalls')}")

finish()
