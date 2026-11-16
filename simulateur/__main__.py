"""Lancement : python3 -m simulateur [--scenario honnetes] [--jours 180] [--graine 42] [--csv dossier] [--tous]"""
import argparse
from dataclasses import replace
from pathlib import Path

from .moteur import Simulation
from .parametres import Parametres
from .rapport import comparatif, exporter_csv, mesures, rapport
from .scenarios import SCENARIOS


def main() -> None:
    ap = argparse.ArgumentParser(description="Simulateur du système de confiance")
    ap.add_argument("--scenario", default="honnetes", choices=sorted(SCENARIOS))
    ap.add_argument("--jours", type=int, help="remplace la durée du scénario")
    ap.add_argument("--graine", type=int, default=42)
    ap.add_argument("--csv", type=Path, help="dossier où exporter les résultats en CSV")
    ap.add_argument("--tous", action="store_true", help="lance tous les scénarios et les compare")
    args = ap.parse_args()

    if args.tous:
        resultats = []
        for nom, scenario in SCENARIOS.items():
            if args.jours:
                scenario = replace(scenario, jours=args.jours)
            sim = Simulation(Parametres(), scenario, args.graine).executer()
            resultats.append((nom, mesures(sim)))
        print(f"Comparatif des scénarios (graine {args.graine})\n")
        print(comparatif(resultats))
        return

    scenario = SCENARIOS[args.scenario]
    if args.jours:
        scenario = replace(scenario, jours=args.jours)
    sim = Simulation(Parametres(), scenario, args.graine).executer()
    print(rapport(sim, args.graine))
    if args.csv:
        exporter_csv(sim, args.csv)
        print(f"\nCSV exportés dans {args.csv}")


if __name__ == "__main__":
    main()
