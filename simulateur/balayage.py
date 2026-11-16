"""Balayage des réglages.

    python3 -m simulateur.balayage [--graines 3] [--processus N] [--jury] [--infiltres] [--score]

1. Ablation : on ajoute les corrections une par une pour voir l'effet de chacune.
2. Grille : 72 combinaisons, classées par un coût qui pénalise surtout les erreurs visibles.
3. Détail de la meilleure combinaison sur tous les scénarios.
"""
import argparse
import csv
import itertools
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from pathlib import Path
from statistics import mean

from .moteur import Simulation
from .parametres import Parametres
from .rapport import _tableau, mesures, nb, pct
from .scenarios import SCENARIOS

CLES = ["fausses_publiees", "fausses_attaquants_publiees", "vraies_rejetees",
        "vraies_ciblees_non_publiees", "vraies_publiees", "fausses_en_debat",
        "jury_part_attaquants", "poids_max_attaquants", "delai_moyen", "via_jury",
        "attaquants_signales", "honnetes_signales", "attaquants_top30"]

# Meilleur réglage de l'étape 3, point de départ du balayage du jury
BASE_RETENUE = {"tirage": "tous", "relectures_max_par_jour": 5, "jury_actif": True,
                "seuil_publication": 0.65, "seuil_rejet": 0.35,
                "taux_controle": 0.15, "perte_controle": 1.0}

# Réglages validés après le balayage du jury (détection en simple alerte)
RETENU = {**BASE_RETENUE, "jury_part_eligible": 0.30, "jury_taille": 11, "jury_majorite": 8 / 11,
          "jury_votes_min": 8, "detection_collusion": True, "collusion_seuil": 3,
          "facteur_suspect": 1.0}

GRILLE_INFILTRES = {
    "plancher": {"sans plancher": {"jury_plancher_publication": 0.0},
                 "plancher 50 %": {"jury_plancher_publication": 0.5}},
    "rotation": {"2 jurys/semaine": {"jury_fenetre_jours": 7, "jury_max_par_fenetre": 2},
                 "2 jurys/mois": {"jury_fenetre_jours": 30, "jury_max_par_fenetre": 2}},
    "double jury": {"jury simple": {"jury_double_publication": False},
                    "double jury pour publier": {"jury_double_publication": True}},
}

GRILLE_JURY = {
    "vivier": {"top 10 %": {"jury_part_eligible": 0.10}, "top 30 %": {"jury_part_eligible": 0.30},
               "top 50 %": {"jury_part_eligible": 0.50}},
    "majorité": {"6/7": {"jury_taille": 7, "jury_majorite": 6 / 7, "jury_votes_min": 5},
                 "5/7": {"jury_taille": 7, "jury_majorite": 5 / 7, "jury_votes_min": 5},
                 "7/9": {"jury_taille": 9, "jury_majorite": 7 / 9, "jury_votes_min": 7},
                 "8/11": {"jury_taille": 11, "jury_majorite": 8 / 11, "jury_votes_min": 8}},
    "détection": {"sans détection": {"detection_collusion": False},
                  "détection (seuil 3)": {"detection_collusion": True, "collusion_seuil": 3}},
}

ABLATION = [
    ("Réglages actuels", {}),
    ("+ tirage par convocation", {"tirage": "tous"}),
    ("+ plafond 3 relectures/jour", {"relectures_max_par_jour": 3}),
    ("+ contrôles 15 %, sanction 1", {"taux_controle": 0.15, "perte_controle": 1.0}),
    ("+ jury de second examen", {"jury_actif": True}),
    ("+ seuil de publication 65 %", {"seuil_publication": 0.65, "seuil_rejet": 0.35}),
]

GRILLE = {
    "tirage": {"connectés": {"tirage": "connectes"}, "convocation": {"tirage": "tous"}},
    "plafond": {"5/jour": {"relectures_max_par_jour": 5},
                "3/jour": {"relectures_max_par_jour": 3},
                "3→5 selon réputation": {"relectures_max_par_jour": 3, "plafond_reputation": True,
                                         "plafond_max": 5}},
    "jury": {"sans jury": {"jury_actif": False}, "jury": {"jury_actif": True}},
    "seuil": {"70 %": {"seuil_publication": 0.70, "seuil_rejet": 0.30},
              "65 %": {"seuil_publication": 0.65, "seuil_rejet": 0.35},
              "60 %": {"seuil_publication": 0.60, "seuil_rejet": 0.40}},
    "contrôles": {"5 %": {"taux_controle": 0.05, "perte_controle": 0.3},
                  "15 %": {"taux_controle": 0.15, "perte_controle": 1.0}},
}


def _executer(tache):
    reglages, scenario, graine = tache
    sim = Simulation(replace(Parametres(), **reglages), SCENARIOS[scenario], graine).executer()
    m = mesures(sim)
    return {k: m[k] for k in CLES}


def evaluer(pool, configs: list[dict], scenarios: list[str], graines: list[int]) -> list[dict]:
    """Renvoie, pour chaque config, {scenario: mesures moyennées sur les graines}."""
    taches = [(c, s, g) for c in configs for s in scenarios for g in graines]
    resultats = list(pool.map(_executer, taches, chunksize=4))
    sortie, i = [], 0
    for _ in configs:
        par_scenario = {}
        for s in scenarios:
            lot = resultats[i:i + len(graines)]
            i += len(graines)
            par_scenario[s] = {k: mean(r[k] for r in lot) for k in CLES}
        sortie.append(par_scenario)
    return sortie


def cout(res: dict) -> float:
    """Erreurs visibles (fausse publiée, vraie rejetée) x4 ; vraie non publiée x1 ; sur « tout » et « honnetes »."""
    total = 0.0
    for s in ("tout", "honnetes"):
        m = res[s]
        total += 4 * m["fausses_publiees"] + 4 * m["vraies_rejetees"] + (1 - m["vraies_publiees"])
    return total


def cout_jury(res: dict) -> float:
    """Coût de base + vraies vidéos ciblées non publiées (ce que le jury doit débloquer)."""
    return cout(res) + res["tout"]["vraies_ciblees_non_publiees"]


def balayage_jury(pool, graines: list[int], sortie: Path) -> None:
    axes = list(GRILLE_JURY)
    combinaisons = list(itertools.product(*(GRILLE_JURY[a].items() for a in axes)))
    configs = [{**BASE_RETENUE, **{k: v for _, d in combo for k, v in d.items()}} for combo in combinaisons]
    libelles = [", ".join(nom for nom, _ in combo) for combo in combinaisons]
    scenarios = ["honnetes", "tout", "brigade", "dormants"]
    res = evaluer(pool, configs, scenarios, graines)
    classement = sorted(zip(libelles, res), key=lambda x: cout_jury(x[1]))
    print(f"Balayage du jury : {len(configs)} combinaisons, {len(graines)} graines\n")
    lignes = [[str(i + 1), lib, nb(cout_jury(r), 3),
               pct(r["tout"]["fausses_publiees"]), pct(r["tout"]["vraies_rejetees"]),
               pct(r["tout"]["vraies_publiees"]), pct(r["tout"]["vraies_ciblees_non_publiees"]),
               pct(r["dormants"]["fausses_publiees"]), pct(r["tout"]["jury_part_attaquants"]),
               pct(r["honnetes"]["vraies_publiees"]), pct(r["tout"]["honnetes_signales"])]
              for i, (lib, r) in enumerate(classement)]
    print(_tableau(["#", "Réglages du jury", "Coût", "Fausses publiées", "Vraies rejetées",
                    "Vraies publiées", "Vraies ciblées non publiées", "Fausses publiées (dormants)",
                    "Jury : votes attaquants", "Vraies publiées (honnêtes)", "Honnêtes signalés"],
                   lignes))
    sortie.mkdir(parents=True, exist_ok=True)
    with open(sortie / "balayage_jury.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["reglages", "cout"] + [f"{s}_{k}" for s in scenarios for k in CLES])
        for lib, r in classement:
            w.writerow([lib, round(cout_jury(r), 4)] + [round(r[s][k], 4) for s in scenarios for k in CLES])
    print(f"\nRésultats complets : {sortie / 'balayage_jury.csv'}")


def cout_infiltres(res: dict) -> float:
    total = 0.0
    for s in ("honnetes", "tout", "tout+infiltres"):
        m = res[s]
        total += 4 * m["fausses_publiees"] + 4 * m["vraies_rejetees"] + (1 - m["vraies_publiees"])
    return total + res["tout"]["vraies_ciblees_non_publiees"] + res["tout+infiltres"]["vraies_ciblees_non_publiees"]


def balayage_infiltres(pool, graines: list[int], sortie: Path) -> None:
    axes = list(GRILLE_INFILTRES)
    combinaisons = list(itertools.product(*(GRILLE_INFILTRES[a].items() for a in axes)))
    configs = [{**RETENU, **{k: v for _, d in combo for k, v in d.items()}} for combo in combinaisons]
    libelles = [", ".join(nom for nom, _ in combo) for combo in combinaisons]
    scenarios = ["honnetes", "tout", "infiltres", "tout+infiltres"]
    res = evaluer(pool, configs, scenarios, graines)
    classement = sorted(zip(libelles, configs, res), key=lambda x: cout_infiltres(x[2]))
    print(f"Parades contre les infiltrés : {len(configs)} combinaisons, graines {graines[0]} à {graines[-1]}\n")
    lignes = [[str(i + 1), lib, nb(cout_infiltres(r), 3),
               pct(r["tout+infiltres"]["fausses_publiees"]), pct(r["tout+infiltres"]["vraies_rejetees"]),
               pct(r["tout+infiltres"]["vraies_publiees"]), pct(r["infiltres"]["fausses_publiees"]),
               pct(r["tout"]["fausses_publiees"]), pct(r["tout"]["vraies_publiees"]),
               pct(r["honnetes"]["vraies_publiees"]), nb(r["tout+infiltres"]["delai_moyen"], 1)]
              for i, (lib, _, r) in enumerate(classement)]
    print(_tableau(["#", "Parades", "Coût", "Fausses publiées (tout+inf.)", "Vraies rejetées (tout+inf.)",
                    "Vraies publiées (tout+inf.)", "Fausses publiées (infiltrés)",
                    "Fausses publiées (tout)", "Vraies publiées (tout)", "Vraies publiées (honnêtes)",
                    "Délai (tout+inf.)"], lignes))

    # Validation sur graines neuves : réglage retenu actuel contre la meilleure parade
    lib, meilleur, _ = classement[0]
    neuves = list(range(601, 611))
    res_val = evaluer(pool, [RETENU, meilleur], list(SCENARIOS), neuves)
    print(f"\nValidation sur graines neuves 601 à 610 : « retenu actuel » contre « {lib} »\n")
    lignes = []
    for s in SCENARIOS:
        for nom, r in (("retenu actuel", res_val[0]), ("avec parades", res_val[1])):
            m = r[s]
            lignes.append([s if nom == "retenu actuel" else "", nom, pct(m["fausses_publiees"]),
                           pct(m["vraies_rejetees"]), pct(m["vraies_publiees"]),
                           pct(m["vraies_ciblees_non_publiees"])
                           if s in ("brigade", "tout", "infiltres", "tout+infiltres") else "-",
                           nb(m["delai_moyen"], 1)])
    print(_tableau(["Scénario", "Réglages", "Fausses publiées", "Vraies rejetées", "Vraies publiées",
                    "Vraies ciblées non publiées", "Délai (jours)"], lignes))


def balayage_score(pool, sortie: Path) -> None:
    """Compare le score « cumul » au score « precision » (taux de bonnes réponses), avec ou sans plancher."""
    configs = {}
    for plancher in (0.0, 0.5):
        nom_pl = "plancher 50 %" if plancher else "sans plancher"
        configs[f"cumul, {nom_pl}"] = {**RETENU, "jury_plancher_publication": plancher}
        for memoire in (1.0, 0.98, 0.95):
            for pc in (1.0, 3.0):
                configs[f"précision, mémoire {memoire}, contrôle x{pc:g}, {nom_pl}"] = {
                    **RETENU, "jury_plancher_publication": plancher, "mode_score": "precision",
                    "memoire": memoire, "poids_controle": pc}
    scenarios = ["honnetes", "tout", "dormants", "infiltres", "tout+infiltres"]
    res = evaluer(pool, list(configs.values()), scenarios, list(range(1, 7)))
    classement = sorted(zip(configs, configs.values(), res), key=lambda x: cout_infiltres(x[2]))
    print(f"Score cumulé contre score par taux de bonnes réponses : {len(configs)} réglages, graines 1 à 6\n")
    lignes = [[str(i + 1), lib, nb(cout_infiltres(r), 3),
               pct(r["tout+infiltres"]["fausses_publiees"]), pct(r["tout+infiltres"]["vraies_rejetees"]),
               pct(r["tout+infiltres"]["vraies_publiees"]), pct(r["tout"]["vraies_publiees"]),
               pct(r["dormants"]["fausses_publiees"]), pct(r["tout+infiltres"]["attaquants_top30"]),
               pct(r["tout+infiltres"]["jury_part_attaquants"]), pct(r["honnetes"]["vraies_publiees"])]
              for i, (lib, _, r) in enumerate(classement)]
    print(_tableau(["#", "Réglages", "Coût", "Fausses publiées (tout+inf.)", "Vraies rejetées (tout+inf.)",
                    "Vraies publiées (tout+inf.)", "Vraies publiées (tout)", "Fausses publiées (dormants)",
                    "Attaquants dans le top 30 %", "Jury : votes attaquants",
                    "Vraies publiées (honnêtes)"], lignes))

    # Validation sur graines neuves : meilleur « cumul » contre meilleur « précision »
    meilleur_cumul = next(x for x in classement if x[0].startswith("cumul"))
    meilleur_prec = next(x for x in classement if x[0].startswith("précision"))
    neuves = list(range(801, 813))
    res_val = evaluer(pool, [meilleur_cumul[1], meilleur_prec[1]], list(SCENARIOS), neuves)
    print(f"\nValidation sur graines neuves 801 à 812\n  A = {meilleur_cumul[0]}\n  B = {meilleur_prec[0]}\n")
    lignes = []
    for sc in SCENARIOS:
        for nom, r in (("A", res_val[0]), ("B", res_val[1])):
            m = r[sc]
            lignes.append([sc if nom == "A" else "", nom, pct(m["fausses_publiees"]), pct(m["vraies_rejetees"]),
                           pct(m["vraies_publiees"]),
                           pct(m["vraies_ciblees_non_publiees"]) if m["vraies_ciblees_non_publiees"] or sc in
                           ("brigade", "tout", "infiltres", "tout+infiltres") else "-",
                           pct(m["attaquants_top30"]), nb(m["delai_moyen"], 1)])
    print(_tableau(["Scénario", "Réglages", "Fausses publiées", "Vraies rejetées", "Vraies publiées",
                    "Vraies ciblées non publiées", "Attaquants top 30 %", "Délai (jours)"], lignes))


def main() -> None:
    ap = argparse.ArgumentParser(description="Balayage des réglages du système de confiance")
    ap.add_argument("--graines", type=int, default=3)
    ap.add_argument("--processus", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--sortie", type=Path, default=Path("resultats"))
    ap.add_argument("--jury", action="store_true", help="balaye seulement les réglages du jury")
    ap.add_argument("--infiltres", action="store_true", help="teste les parades contre les infiltrés")
    ap.add_argument("--score", action="store_true", help="compare score cumulé et score par taux de bonnes réponses")
    args = ap.parse_args()
    graines = list(range(1, args.graines + 1))
    tous = list(SCENARIOS)

    if args.score:
        with ProcessPoolExecutor(args.processus) as pool:
            balayage_score(pool, args.sortie)
        return

    if args.infiltres:
        with ProcessPoolExecutor(args.processus) as pool:
            balayage_infiltres(pool, list(range(1, 7)), args.sortie)
        return

    if args.jury:
        with ProcessPoolExecutor(args.processus) as pool:
            balayage_jury(pool, graines, args.sortie)
        return

    with ProcessPoolExecutor(args.processus) as pool:
        # 1. Ablation cumulative
        configs, cumul = [], {}
        for _, ajout in ABLATION:
            cumul = {**cumul, **ajout}
            configs.append(dict(cumul))
        res_abl = evaluer(pool, configs, ["honnetes", "tout"], graines)
        print(f"1. Corrections ajoutées une à une (moyenne sur {len(graines)} graines, scénario « tout » "
              f"sauf dernière colonne)\n")
        lignes = [[nom, pct(r["tout"]["fausses_publiees"]), pct(r["tout"]["vraies_rejetees"]),
                   pct(r["tout"]["vraies_ciblees_non_publiees"]), pct(r["tout"]["vraies_publiees"]),
                   pct(r["tout"]["fausses_en_debat"]), pct(r["tout"]["jury_part_attaquants"]),
                   pct(r["honnetes"]["vraies_publiees"])]
                  for (nom, _), r in zip(ABLATION, res_abl)]
        print(_tableau(["Étape", "Fausses publiées", "Vraies rejetées", "Vraies ciblées non publiées",
                        "Vraies publiées", "Fausses en débat", "Jury : votes attaquants",
                        "Vraies publiées (honnêtes)"], lignes))

        # 2. Grille
        noms_axes = list(GRILLE)
        combinaisons = list(itertools.product(*(GRILLE[a].items() for a in noms_axes)))
        configs = [{k: v for _, d in combo for k, v in d.items()} for combo in combinaisons]
        libelles = [", ".join(nom for nom, _ in combo) for combo in combinaisons]
        res_grille = evaluer(pool, configs, ["honnetes", "tout"], graines)
        classement = sorted(zip(libelles, configs, res_grille), key=lambda x: cout(x[2]))

        print(f"\n2. Les 10 meilleures combinaisons sur {len(configs)} (coût : plus bas = mieux)\n")
        lignes = [[str(i + 1), lib, nb(cout(r), 3), pct(r["tout"]["fausses_publiees"]),
                   pct(r["tout"]["vraies_rejetees"]), pct(r["tout"]["vraies_publiees"]),
                   pct(r["honnetes"]["vraies_publiees"])]
                  for i, (lib, _, r) in enumerate(classement[:10])]
        print(_tableau(["#", "Réglages", "Coût", "Fausses publiées", "Vraies rejetées",
                        "Vraies publiées", "Vraies publiées (honnêtes)"], lignes))

        args.sortie.mkdir(parents=True, exist_ok=True)
        with open(args.sortie / "balayage.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["reglages", "cout"] + [f"{s}_{k}" for s in ("tout", "honnetes") for k in CLES])
            for lib, _, r in classement:
                w.writerow([lib, round(cout(r), 4)] +
                           [round(r[s][k], 4) for s in ("tout", "honnetes") for k in CLES])

        # 3. Détail du meilleur réglage
        lib, meilleur, _ = classement[0]
        (res_det,) = evaluer(pool, [meilleur], tous, graines)
        print(f"\n3. Meilleure combinaison sur chaque scénario : {lib}\n")
        lignes = [[s, pct(res_det[s]["fausses_publiees"]), pct(res_det[s]["vraies_rejetees"]),
                   pct(res_det[s]["vraies_ciblees_non_publiees"]) if s in ("brigade", "tout") else "-",
                   pct(res_det[s]["vraies_publiees"]), pct(res_det[s]["fausses_en_debat"]),
                   pct(res_det[s]["jury_part_attaquants"]), nb(res_det[s]["delai_moyen"], 1)]
                  for s in tous]
        print(_tableau(["Scénario", "Fausses publiées", "Vraies rejetées", "Vraies ciblées non publiées",
                        "Vraies publiées", "Fausses en débat", "Jury : votes attaquants",
                        "Délai (jours)"], lignes))
        print(f"\nRésultats complets : {args.sortie / 'balayage.csv'}")


if __name__ == "__main__":
    main()
