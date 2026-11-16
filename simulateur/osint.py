"""Analystes OSINT vérifiés par l'administrateur : score de départ plus élevé, sans période de novice.

    python3 -m simulateur.osint [--processus N]

Question : quelques comptes à fort poids améliorent-ils les décisions, et, s'ils sont piratés ou
retournés tous en même temps, peuvent-ils faire basculer des décisions ? Réglages retenus (RETENU),
score de départ OSINT 1 (aucun avantage), 3 (proposé) et 5, graines 401 à 405.
"""
import argparse
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from statistics import mean

from .balayage import RETENU
from .moteur import Simulation
from .parametres import Parametres
from .rapport import _tableau, mesures, pct
from .scenarios import SCENARIOS, Vague

TOUT = SCENARIOS["tout"]
HONNETES = SCENARIOS["honnetes"]
CAS = {
    "honnêtes + 10 OSINT": replace(HONNETES, vagues=(Vague("osint", 10, jour=0),)),
    "tout + 10 OSINT": replace(TOUT, vagues=TOUT.vagues + (Vague("osint", 10, jour=0),)),
    "honnêtes + 10 OSINT compromis (j120)": replace(
        HONNETES, vagues=(Vague("osint_compromis", 10, jour=0, jour_attaque=120),),
        fausses_attaquants_par_jour=5, jour_debut_fausses=120, taux_cible_authentiques=0.30),
    "tout + 10 OSINT compromis (j120)": replace(
        TOUT, vagues=TOUT.vagues + (Vague("osint_compromis", 10, jour=0, jour_attaque=120),)),
    "tout + 30 OSINT compromis (j120)": replace(
        TOUT, vagues=TOUT.vagues + (Vague("osint_compromis", 30, jour=0, jour_attaque=120),)),
}
SCORES = (1.0, 3.0, 5.0)
GRAINES = range(401, 406)
INDICATEURS = [("fausses_publiees", "Fausses publiées"), ("fausses_attaquants_publiees", "Fausses des attaquants publiées"),
               ("vraies_rejetees", "Vraies rejetées"), ("vraies_publiees", "Vraies publiées"),
               ("vraies_ciblees_non_publiees", "Vraies ciblées non publiées")]


def _executer(tache):
    score, scenario, graine = tache
    return mesures(Simulation(replace(Parametres(), **RETENU, score_osint=score), scenario, graine).executer())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--processus", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    taches = [(s, sc, g) for sc in CAS.values() for s in SCORES for g in GRAINES]
    with ProcessPoolExecutor(args.processus) as pool:
        res = iter(pool.map(_executer, taches, chunksize=2))
        lignes = []
        for nom in CAS:
            for score in SCORES:
                lot = [next(res) for _ in GRAINES]
                cellules = []
                for cle, _ in INDICATEURS:
                    if (cle == "fausses_attaquants_publiees" and not any(m["a_des_cibles"] for m in lot)) or \
                       (cle == "vraies_ciblees_non_publiees" and not any(m["a_des_vraies_ciblees"] for m in lot)):
                        cellules.append("-")
                        continue
                    v = [m[cle] for m in lot]
                    cellules.append(f"{pct(mean(v))} ({pct(min(v))}–{pct(max(v))})")
                lignes.append([nom if score == SCORES[0] else "", f"{score:g}"] + cellules)
    print(_tableau(["Scénario", "Score OSINT"] + [lib + " moy. (min–max)" for _, lib in INDICATEURS], lignes))


if __name__ == "__main__":
    main()
