"""Mesures et rapport texte d'une simulation."""
import csv
from collections import Counter
from pathlib import Path

from .moteur import Simulation
from .population import ATTAQUANTS
from .videos import STATUTS_FINAUX

LIBELLES = {"publiee": "Publiées", "rejetee": "Rejetées",
            "contestee": "Contestées", "sans_decision": "Sans décision"}


def pct(x: float) -> str:
    return f"{x * 100:.1f} %".replace(".", ",")


def nb(x: float, dec: int = 2) -> str:
    return f"{x:.{dec}f}".replace(".", ",")


def mesures(sim: Simulation) -> dict:
    videos = [v for v in sim.terminees if not v.est_controle]
    tranchees = [v for v in videos if v.statut != "sans_decision"]
    fausses = [v for v in videos if v.verite is False]
    vraies = [v for v in videos if v.verite is True]
    ambigues = [v for v in videos if v.verite is None]

    def taux(groupe, condition):
        return sum(1 for v in groupe if condition(v)) / len(groupe) if groupe else 0.0

    return {
        "videos": len(videos),
        "fausses_publiees": taux(fausses, lambda v: v.statut == "publiee"),
        "vraies_rejetees": taux(vraies, lambda v: v.statut == "rejetee"),
        "vraies_publiees": taux(vraies, lambda v: v.statut == "publiee"),
        "ambigues_contestees": taux(ambigues, lambda v: v.statut == "contestee"),
        "sans_decision": taux(videos, lambda v: v.statut == "sans_decision"),
        "delai_moyen": (sum(v.jour_decision - v.jour_arrivee for v in tranchees) / len(tranchees)
                        if tranchees else 0.0),
        "votes_moyens": sum(len(v.votes) for v in videos) / len(videos) if videos else 0.0,
        "fausses_attaquants_publiees": taux([v for v in fausses if v.cible],
                                            lambda v: v.statut == "publiee"),
        "fausses_ordinaires_publiees": taux([v for v in fausses if not v.cible],
                                            lambda v: v.statut == "publiee"),
        "vraies_ciblees_non_publiees": taux([v for v in vraies if v.cible],
                                            lambda v: v.statut != "publiee"),
        "vraies_ciblees_rejetees": taux([v for v in vraies if v.cible],
                                        lambda v: v.statut == "rejetee"),
        "a_des_cibles": any(v.cible for v in videos),
        "a_des_vraies_ciblees": any(v.cible for v in vraies),
        "fausses_en_debat": taux(fausses, lambda v: v.statut == "contestee"),
        "via_jury": taux(videos, lambda v: v.jour_jury is not None),
        "jury_part_attaquants": _part_attaquants_jury(sim, videos),
        "attaquants_signales": (sum(u.suspect for u in sim.attaquants) / len(sim.attaquants)
                                if sim.attaquants else 0.0),
        "honnetes_signales": (sum(u.suspect for u in sim.utilisateurs if u.profil not in ATTAQUANTS)
                              / max(1, sum(1 for u in sim.utilisateurs if u.profil not in ATTAQUANTS))),
        "attaquants_top30": _part_attaquants_top(sim, 0.30),
        "poids_max_attaquants": max((sum(d["part_poids"] for nom, d in h["profils"].items()
                                         if nom in ATTAQUANTS) for h in sim.historique), default=0.0),
    }


def _part_attaquants_jury(sim: Simulation, videos: list) -> float:
    votes = [vote for v in videos for vote in v.votes_jury_precedents + v.votes_jury]
    if not votes:
        return 0.0
    return sum(1 for vote in votes if sim.par_id[vote.uid].profil in ATTAQUANTS) / len(votes)


def _part_attaquants_top(sim: Simulation, part: float) -> float:
    anciens = sorted((u for u in sim.utilisateurs
                      if sim.jour - u.jour_inscription >= sim.p.jury_anciennete_jours),
                     key=lambda u: -u.score)
    top = anciens[:max(1, int(len(anciens) * part))]
    return sum(1 for u in top if u.profil in ATTAQUANTS) / len(top) if top else 0.0


def _tableau(entetes: list[str], lignes: list[list[str]]) -> str:
    largeurs = [max(len(str(c)) for c in col) for col in zip(entetes, *lignes)]
    fmt = lambda ligne: "| " + " | ".join(str(c).ljust(w) for c, w in zip(ligne, largeurs)) + " |"
    sep = "|" + "|".join("-" * (w + 2) for w in largeurs) + "|"
    return "\n".join([fmt(entetes), sep] + [fmt(l) for l in lignes])


def rapport(sim: Simulation, graine: int) -> str:
    m = mesures(sim)
    videos = [v for v in sim.terminees if not v.est_controle]
    sortie = [f"=== Scénario « {sim.sc.nom} » : {sim.sc.jours} jours, graine {graine} ===",
              sim.sc.description,
              f"Comptes en fin de simulation : {len(sim.utilisateurs)} · "
              f"vidéos traitées : {m['videos']} · encore en attente : "
              f"{sum(1 for v in sim.en_attente if not v.est_controle)}", ""]

    # Décisions par nature
    lignes = []
    for nature in ("authentique", "fausse", "ancienne", "ambigue"):
        groupe = [v for v in videos if v.nature == nature]
        c = Counter(v.statut for v in groupe)
        lignes.append([nature] + [str(c[s]) for s in STATUTS_FINAUX] + [str(len(groupe))])
    sortie += ["Décisions par nature de vidéo",
               _tableau(["Nature"] + [LIBELLES[s] for s in STATUTS_FINAUX] + ["Total"], lignes), ""]

    sortie += ["Indicateurs clés",
               f"- Fausses ou anciennes publiées : {pct(m['fausses_publiees'])}",
               f"- Authentiques rejetées : {pct(m['vraies_rejetees'])}",
               f"- Authentiques publiées : {pct(m['vraies_publiees'])}",
               f"- Ambiguës classées « contestée » : {pct(m['ambigues_contestees'])}",
               f"- Vidéos sans décision faute de poids : {pct(m['sans_decision'])}",
               f"- Fausses ou anciennes laissées « en débat » : {pct(m['fausses_en_debat'])}",
               f"- Vidéos passées devant un jury : {pct(m['via_jury'])} · "
               f"votes de jury exprimés par des attaquants : {pct(m['jury_part_attaquants'])}",
               f"- Délai moyen de décision : {nb(m['delai_moyen'], 1)} jour(s) · "
               f"votes par vidéo : {nb(m['votes_moyens'], 1)}", ""]
    if m["a_des_cibles"] or sim.attaquants:
        sortie += ["Effet des attaques",
                   f"- Fausses vidéos des attaquants publiées : {pct(m['fausses_attaquants_publiees'])} "
                   f"(fausses ordinaires : {pct(m['fausses_ordinaires_publiees'])})",
                   f"- Vraies vidéos ciblées rejetées : {pct(m['vraies_ciblees_rejetees'])} · "
                   f"non publiées (rejetées ou contestées) : {pct(m['vraies_ciblees_non_publiees'])}",
                   f"- Poids maximal détenu par les attaquants : {pct(m['poids_max_attaquants'])}", ""]

    # Erreurs par mois d'arrivée : montre le démarrage à froid
    lignes = []
    for mois in range(0, sim.sc.jours, 30):
        groupe = [v for v in videos if mois <= v.jour_arrivee < mois + 30]
        if not groupe:
            continue
        f = [v for v in groupe if v.verite is False]
        t = [v for v in groupe if v.verite is True]
        lignes.append([f"Mois {mois // 30 + 1}",
                       pct(sum(v.statut == "publiee" for v in f) / len(f)) if f else "-",
                       pct(sum(v.statut == "rejetee" for v in t) / len(t)) if t else "-",
                       pct(sum(v.statut == "sans_decision" for v in groupe) / len(groupe))])
    sortie += ["Évolution par mois d'arrivée",
               _tableau(["Période", "Fausses publiées", "Authentiques rejetées", "Sans décision"],
                        lignes), ""]

    # Scores par profil
    profils = sim.ordre_profils()
    etapes = sim.historique[::3] + ([sim.historique[-1]] if len(sim.historique) % 3 != 1 else [])
    lignes = [[f"Jour {h['jour']}"] + [nb(h["profils"][p]["score_moyen"]) if p in h["profils"] else "-"
                                       for p in profils]
              for h in etapes]
    sortie += ["Score moyen par profil", _tableau(["Jour"] + profils, lignes), ""]

    final = sim.historique[-1]["profils"]
    sortie += ["Part du poids total en fin de simulation"]
    sortie += [f"- {p} : {pct(final[p]['part_poids'])}" for p in profils if p in final]
    return "\n".join(sortie)


def comparatif(resultats: list[tuple[str, dict]]) -> str:
    entetes = ["Scénario", "Fausses publiées", "dont des attaquants", "Vraies rejetées",
               "Vraies ciblées non publiées", "Vraies publiées", "Poids max attaquants"]
    lignes = [[nom, pct(m["fausses_publiees"]),
               pct(m["fausses_attaquants_publiees"]) if m["a_des_cibles"] else "-",
               pct(m["vraies_rejetees"]),
               pct(m["vraies_ciblees_non_publiees"]) if m["a_des_vraies_ciblees"] else "-",
               pct(m["vraies_publiees"]), pct(m["poids_max_attaquants"])]
              for nom, m in resultats]
    return _tableau(entetes, lignes)


def exporter_csv(sim: Simulation, dossier: Path) -> None:
    dossier.mkdir(parents=True, exist_ok=True)
    with open(dossier / "scores_par_profil.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["jour", "profil", "score_moyen", "part_poids"])
        for h in sim.historique:
            for profil, d in h["profils"].items():
                w.writerow([h["jour"], profil, round(d["score_moyen"], 4), round(d["part_poids"], 4)])
    with open(dossier / "videos.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "nature", "difficulte", "jour_arrivee", "jour_decision",
                    "statut", "ratio_final", "votes"])
        for v in sim.terminees:
            if not v.est_controle:
                w.writerow([v.id, v.nature, round(v.difficulte, 3), v.jour_arrivee,
                            v.jour_decision, v.statut,
                            "" if v.ratio_final is None else round(v.ratio_final, 3), len(v.votes)])
