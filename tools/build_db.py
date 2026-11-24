"""Construit la base d'empreintes des cartes FR pour le scanner.

Lancé par GitHub Actions (.github/workflows/build-db.yml).
Incrémental : seules les nouvelles cartes sont téléchargées.

Sorties dans db/ :
  index.json    -> {"v":1, "dim":D, "scale":S, "sets":{id:[nom, total officiel]},
                    "cards":[[id, nom, numéro, setId, chemin image], ...]}
  features.bin  -> int8, len(cards) x D, même ordre que "cards"
"""
import io
import json
import os
import sys
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from features import feature, DIM  # noqa: E402

API = "https://api.tcgdex.net/v2/fr"
OUT = os.path.join(os.path.dirname(__file__), "..", "db")
SCALE = 32.0
BUDGET = float(os.environ.get("BUDGET_MIN", "95")) * 60  # temps max avant sauvegarde finale
T0 = time.time()
session = requests.Session()
session.headers["User-Agent"] = "pokescan-db-builder"


def get(url, binary=False, tries=4):
    for i in range(tries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 200:
                if binary:
                    if r.content[:4] == b"\x89PNG":
                        return r.content
                else:
                    return r.json()
            if r.status_code == 404:
                return None
        except requests.RequestException:
            pass
        time.sleep(2 ** i)
    return None


def load_old():
    try:
        idx = json.load(open(os.path.join(OUT, "index.json")))
        if idx.get("dim") != DIM:
            return {}
        feats = np.fromfile(os.path.join(OUT, "features.bin"), dtype=np.int8).reshape(-1, DIM)
        return {c[0]: feats[i] for i, c in enumerate(idx["cards"])}
    except (OSError, ValueError, KeyError):
        return {}


def main():
    os.makedirs(OUT, exist_ok=True)
    sets = get(API + "/sets")
    brief = get(API + "/cards")
    old = load_old()
    todo = [c for c in brief if c.get("image") and c["id"] not in old]
    if os.environ.get("LIMIT"):  # pour tester
        todo = todo[: int(os.environ["LIMIT"])]
    print(f"{len(brief)} cartes, {len(old)} déjà connues, {len(todo)} à traiter")

    def work(c):
        data = get(c["image"] + "/low.png", binary=True)
        if not data:
            return c["id"], None
        try:
            f = feature(Image.open(io.BytesIO(data)))
        except Exception as e:  # image corrompue
            print("erreur", c["id"], e)
            return c["id"], None
        return c["id"], np.clip(np.round(f * SCALE), -127, 127).astype(np.int8)

    new = {}
    done = 0
    stopped = False
    with ThreadPoolExecutor(6) as ex:
        it = iter(todo)
        while True:
            batch = [c for _, c in zip(range(300), it)]
            if not batch:
                break
            for cid, f in ex.map(work, batch):
                if f is not None:
                    new[cid] = f
            done += len(batch)
            print(f"{done} / {len(todo)}  ({len(new)} ok, {int(time.time() - T0) // 60} min)", flush=True)
            if done % 2100 == 0:
                save(sets, brief, {**old, **new}, commit=True)
            if time.time() - T0 > BUDGET:
                stopped = True
                break
    save(sets, brief, {**old, **new}, commit=False)
    left = len(todo) - done
    print(f"Fini pour cette fois : {left} cartes restantes", flush=True)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"more={'yes' if stopped and left else 'no'}\n")


def save(sets, brief, feats, commit):
    set_ids = {s["id"] for s in sets}
    cards, rows = [], []
    for c in brief:
        if c["id"] not in feats:
            continue
        # l'id d'une carte = "<setId>-<numéro>" ; le set peut lui-même contenir des tirets
        sid = c["id"][: -(len(c["localId"]) + 1)]
        if sid not in set_ids:
            sid = c["id"].rsplit("-", 1)[0]
        cards.append([c["id"], c["name"], c["localId"], sid, c["image"].split("/fr/", 1)[-1]])
        rows.append(feats[c["id"]])
    idx = {
        "v": 2, "dim": DIM, "scale": SCALE, "built": time.strftime("%Y-%m-%d"),
        "sets": {s["id"]: [s["name"], s.get("cardCount", {}).get("official", 0)] for s in sets},
        "cards": cards,
    }
    np.stack(rows).astype(np.int8).tofile(os.path.join(OUT, "features.bin"))
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Sauvegarde : {len(cards)} cartes dans la base", flush=True)
    if commit and os.environ.get("GITHUB_ACTIONS"):
        sh = lambda *a: subprocess.run(a, cwd=os.path.join(OUT, ".."), check=False)
        sh("git", "add", "db")
        sh("git", "commit", "-qm", f"Base du scanner : {len(cards)} cartes")
        sh("git", "pull", "-q", "--rebase")
        sh("git", "push", "-q")


if __name__ == "__main__":
    main()
