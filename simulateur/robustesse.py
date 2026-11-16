"""Contrôles de robustesse des réglages retenus.

    python3 -m simulateur.robustesse [--processus N]

A. Graines neuves (101 à 110), jamais utilisées pendant le réglage.
B. Conditions différentes : taille de population, attaquants doublés, durée, honnêtes moins fiables.
C. Attaque inconnue pendant le réglage : des infiltrés qui n'attaquent qu'au jury.
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

CONFIGS = {"initial": {}, "retenu": RETENU}
INDICATEURS = [("fausses_publiees", "Fausses publiées"), ("vraies_rejetees", "Vraies rejetées"),
               ("vraies_publiees", "Vraies publiées"),
               ("vraies_ciblees_non_publiees", "Vraies ciblées non publiées")]


def _echelle(sc, facteur_pop=1.0, facteur_attaque=1.0):
    vagues = tuple(Vague(v.profil, round(v.nombre * facteur_pop * facteur_attaque), v.jour, v.jour_attaque)
                   for v in sc.vagues)
    return replace(sc, population_initiale=round(sc.population_initiale * facteur_pop),
                   inscriptions_par_jour=round(sc.inscriptions_par_jour * facteur_pop),
                   videos_par_jour=max(1, round(sc.videos_par_jour * facteur_pop)),
                   fausses_attaquants_par_jour=round(sc.fausses_attaquants_par_jour * facteur_pop
                                                     * facteur_attaque),
                   vagues=vagues)


INFILTRES = SCENARIOS["infiltres"]
TOUT_INFILTRES = SCENARIOS["tout+infiltres"]
VARIANTES = {
    "population 1 000": _echelle(SCENARIOS["tout"], facteur_pop=0.5),
    "population 6 000": _echelle(SCENARIOS["tout"], facteur_pop=3.0),
    "attaquants doublés": _echelle(SCENARIOS["tout"], facteur_attaque=2.0),
    "durée 1 an": replace(SCENARIOS["tout"], jours=365),
    "honnêtes moins fiables": replace(SCENARIOS["tout"], profils={
        "attentif": 0.25, "distrait": 0.30, "hasard": 0.15, "partisan_contre": 0.20, "partisan_pour": 0.10}),
}


def _executer(tache):
    config, scenario, graine = tache
    return mesures(Simulation(replace(Parametres(), **CONFIGS[config]), scenario, graine).executer())


def _bloc(pool, titre, scenarios: dict, graines: list[int]) -> None:
    taches = [(c, sc, g) for sc in scenarios.values() for c in CONFIGS for g in graines]
    res = iter(pool.map(_executer, taches, chunksize=2))
    lignes = []
    for nom, sc in scenarios.items():
        for config in CONFIGS:
            lot = [next(res) for _ in graines]
            cellules = []
            for cle, _ in INDICATEURS:
                if cle == "vraies_ciblees_non_publiees" and not any(m["a_des_vraies_ciblees"] for m in lot):
                    cellules.append("-")
                    continue
                valeurs = [m[cle] for m in lot]
                cellules.append(f"{pct(mean(valeurs))} ({pct(min(valeurs))}–{pct(max(valeurs))})"
                                if len(valeurs) > 1 else pct(valeurs[0]))
            lignes.append([nom if config == "initial" else "", config] + cellules)
    print(f"\n{titre}\n")
    print(_tableau(["Scénario", "Réglages"] + [lib + " moy. (min–max)" for _, lib in INDICATEURS], lignes))


def main() -> None:
    ap = argparse.ArgumentParser(description="Contrôles de robustesse")
    ap.add_argument("--processus", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    with ProcessPoolExecutor(args.processus) as pool:
        _bloc(pool, "A. Graines neuves 101 à 110 (jamais utilisées pendant le réglage)",
              {k: v for k, v in SCENARIOS.items() if k not in ("infiltres", "tout+infiltres")},
              list(range(101, 111)))
        _bloc(pool, "B. Conditions différentes (scénario « tout », graines 201 à 205)",
              VARIANTES, list(range(201, 206)))
        _bloc(pool, "C. Attaque inconnue pendant le réglage (graines 301 à 310)",
              {"infiltres": INFILTRES, "tout+infiltres": TOUT_INFILTRES}, list(range(301, 311)))


if __name__ == "__main__":
    main()
