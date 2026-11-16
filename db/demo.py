"""Données de démonstration pour la base de DÉVELOPPEMENT (jamais en production).

    python3 db/demo.py

1. Crée les comptes de démo (api/scripts/demo.ts) : demo_relecteur, demo_analyste.
2. Remplace les vidéos de démo précédentes (description commençant par « [DÉMO] ») par :
   - 3 vidéos en relecture, avec une convocation pour demo_relecteur ;
   - 1 vidéo devant le jury, avec une convocation au jury pour demo_relecteur ;
   - des notes d'analyste (demo_analyste) sur deux d'entre elles.
   Les vidéos sont des mires générées par ffmpeg, jamais de vraies images, rangées comme des
   versions floutées dans api/.stockage/floutees/<id>/.
3. Donne le statut d'analyste OSINT à demo_relecteur, pour essayer l'espace analyste. Écrire une
   note demandera d'abord d'activer une double authentification dans « Mon compte ».
"""
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate  # noqa: E402

DB = "argos_dev"
RACINE = Path(__file__).resolve().parent.parent
API = RACINE / "api"
FLOUTEES = API / ".stockage" / "floutees"
POLICE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
NODE = Path.home() / ".nvm/versions/node/v24.22.1/bin"

VIDEOS = [
    dict(statut="in_review", categorie="violence", sous="weapons", forces="national_police", situation="demonstration",
         lieu=(2.3631, 48.8673), precision="approx_100m", quand="2026-10-28 15:40+01", meta="coherent",
         description="[DÉMO] Tir de LBD sur un manifestant qui s'éloignait, place de la République, en fin de cortège."),
    dict(statut="in_review", categorie="abuse", sous="filming_obstruction", forces="national_police", situation="stop",
         lieu=(4.8357, 45.7640), precision="municipality", quand="2026-10-30 21:10+01", meta="absent",
         description="[DÉMO] Un agent demande d'arrêter de filmer un contrôle et tente de saisir le téléphone."),
    dict(statut="in_review", categorie="violence", sous="chokehold", forces="gendarmerie", situation="arrest",
         lieu=(5.3698, 43.2965), precision="approx_100m", quand="2026-11-01 02:05+01", meta="incoherent",
         description="[DÉMO] Interpellation avec plaquage ventral prolongé devant un bar, le Vieux-Port."),
    dict(statut="jury", categorie="abuse", sous="insults", forces="municipal_police", situation="other",
         lieu=(-1.5536, 47.2184), precision="approx_100m", quand="2026-10-25 18:30+02", meta="coherent",
         description="[DÉMO] Propos insultants lors d'une verbalisation, quai de la Fosse. Vote serré au premier tour."),
]

NOTES = [
    (0, "Lieu confirmé : place de la République, côté boulevard du Temple",
     "Le kiosque et la bouche de métro visibles à 0:04 correspondent aux images Mapillary de 2025.\n"
     "L'angle de l'ombre est cohérent avec 15 h 40 fin octobre.",
     ["https://www.mapillary.com/app/?lat=48.8673&lng=2.3631&z=17", "https://www.suncalc.org/#/48.8673,2.3631,17/2026.10.28/15:40/1/3"]),
    (2, "Date douteuse : la vidéo circulait déjà en 2024",
     "Une recherche inversée sur une image extraite à 0:02 renvoie un message publié en juin 2024 avec la même scène.\n"
     "Il peut s'agir d'une autre vidéo du même endroit : à confirmer.",
     ["https://exemple.fr/archive/2024/06/message-original"]),
]


def sql(requete: str) -> str:
    r = migrate.psql(DB, requete)
    if r.returncode:
        sys.exit(r.stderr)
    return r.stdout.strip()


def mire(dossier: Path, numero: int) -> None:
    """Mire de démonstration de 12 s : vidéo complète (720p) et aperçu (360p)."""
    dossier.mkdir(parents=True, exist_ok=True)
    texte = f"drawtext=fontfile={POLICE}:text='VIDEO DE DEMONSTRATION {numero}':fontsize=44:fontcolor=white:" \
            "box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=h*0.12," \
            f"drawtext=fontfile={POLICE}:text='Mire generee - aucune vraie image':fontsize=26:fontcolor=white:" \
            "box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h*0.82," \
            f"drawtext=fontfile={POLICE}:text='%{{pts\\:hms}}':fontsize=30:fontcolor=yellow:x=24:y=24"
    for nom, taille in (("video.mp4", "1280x720"), ("apercu.mp4", "640x360")):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={taille}:rate=30:duration=12",
                        "-vf", texte, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
                        "-movflags", "+faststart", str(dossier / nom)], check=True)


# Vidéos publiées et « en débat » pour la carte et les fiches publiques (mires, jamais de vraies images).
VILLES = [
    ("Paris", 2.3522, 48.8566), ("Paris", 2.3770, 48.8530), ("Saint-Denis", 2.3580, 48.9362), ("Lyon", 4.8357, 45.7640),
    ("Marseille", 5.3698, 43.2965), ("Toulouse", 1.4442, 43.6047), ("Nantes", -1.5536, 47.2184), ("Bordeaux", -0.5792, 44.8378),
    ("Lille", 3.0573, 50.6292), ("Rennes", -1.6778, 48.1173), ("Strasbourg", 7.7521, 48.5734), ("Montpellier", 3.8767, 43.6108),
    ("Nice", 7.2620, 43.7102), ("Grenoble", 5.7245, 45.1885), ("Rouen", 1.0993, 49.4432), ("Clermont-Ferrand", 3.0870, 45.7772),
    ("Dijon", 5.0415, 47.3220), ("Brest", -4.4861, 48.3904), ("Limoges", 1.2611, 45.8336), ("Ajaccio", 8.7369, 41.9192),
    ("Bastia", 9.4509, 42.6977), ("Pointe-à-Pitre", -61.5332, 16.2411), ("Fort-de-France", -61.0588, 14.6161),
    ("Saint-Denis (La Réunion)", 55.4504, -20.8823), ("Cayenne", -52.3260, 4.9224),
]
SOUS = {"violence": ["strikes", "disproportionate_force", "weapons", "chokehold"],
        "abuse": ["contested_arrest", "discriminatory_stop", "insults", "intimidation", "filming_obstruction"]}


def publiques(deja: list[str]) -> None:
    import random
    hasard = random.Random(2026)
    modele = FLOUTEES / deja[0]
    for n, (ville, lon, lat) in enumerate(VILLES + VILLES[:3]):
        en_debat = n >= len(VILLES)
        cat = hasard.choice(["violence", "abuse"])
        vid = str(uuid.uuid4())
        jours = hasard.randint(1, 500)
        sql(f"""INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location,
                                         location_precision, description, language, metadata_check, review_started_at,
                                         duration_s, original_sha256, blurred_sha256, first_round_ratio)
                VALUES ('{vid}', 'in_review', '{cat}', '{hasard.choice(SOUS[cat])}',
                        '{hasard.choice(['national_police', 'national_police', 'gendarmerie', 'municipal_police'])}',
                        '{hasard.choice(['demonstration', 'stop', 'arrest', 'other'])}',
                        now() - interval '{jours} days' - interval '{hasard.randint(0, 1400)} minutes',
                        ST_GeogFromText('POINT({lon + hasard.uniform(-0.01, 0.01):.3f} {lat + hasard.uniform(-0.01, 0.01):.3f})'),
                        'approx_100m', $$[DÉMO] {'Vote serré' if en_debat else 'Vidéo publiée'} — {ville}.$$, 'fr', 'coherent',
                        now() - interval '{jours} days', 12, '\\x{secrets.token_hex(32)}', '\\x{secrets.token_hex(32)}',
                        {0.5 if en_debat else 0.82})""")
        sql(f"""INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash)
                VALUES ('{vid}', 'Demo-{secrets.token_hex(2).upper()}-P{n}', '\\x{secrets.token_hex(32)}')""")
        # Passage au statut final par une mise à jour : le journal public inscrit la décision.
        sql(f"""UPDATE core.videos SET status = '{'under_debate' if en_debat else 'published'}', decided_at = now(),
                       decided_by_stage = '{'jury' if en_debat or n % 7 == 3 else 'review'}' WHERE id = '{vid}'""")
        dossier = FLOUTEES / vid
        dossier.mkdir(parents=True, exist_ok=True)
        for nom in ("video.mp4", "apercu.mp4"):
            os.link(modele / nom, dossier / nom)   # même mire pour toutes : liens, pas de copies
    print(f"{len(VILLES)} vidéos publiées et 3 en débat ajoutées")


def main() -> None:
    env = dict(os.environ, PATH=f"{NODE}:{os.environ['PATH']}")
    r = subprocess.run(["node", "--env-file=.env", "--import", "tsx", "scripts/demo.ts"], cwd=API, env=env, text=True)
    if r.returncode:
        sys.exit("échec de la création des comptes de démo")

    relecteur = sql("SELECT id FROM core.accounts WHERE username = 'demo_relecteur'")
    analyste = sql("SELECT id FROM core.accounts WHERE username = 'demo_analyste'")

    # Anciennes vidéos de démo : effacées (convocations, votes et notes partent avec).
    for ancienne in sql("SELECT id FROM core.videos WHERE description LIKE '[DÉMO]%'").split():
        shutil.rmtree(FLOUTEES / ancienne, ignore_errors=True)
    sql("DELETE FROM core.videos WHERE description LIKE '[DÉMO]%'")

    # demo_analyste : double authentification factice (il ne se connecte pas) et statut d'analyste ;
    # demo_relecteur : statut d'analyste pour essayer l'espace analyste.
    sql(f"""INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc, label)
            SELECT '{analyste}', 'totp', '\\x00', 'démo' WHERE NOT EXISTS
              (SELECT 1 FROM core.mfa_factors WHERE account_id = '{analyste}' AND revoked_at IS NULL)""")
    for compte in (analyste, relecteur):
        sql(f"""INSERT INTO core.verifications (account_id, category, expires_at)
                SELECT '{compte}', 'osint_analyst', now() + interval '1 year' WHERE NOT EXISTS
                  (SELECT 1 FROM core.verifications WHERE account_id = '{compte}' AND category = 'osint_analyst'
                      AND revoked_at IS NULL AND expires_at > now())""")

    ids = []
    for n, v in enumerate(VIDEOS, start=1):
        vid = str(uuid.uuid4())
        ids.append(vid)
        lon, lat = v["lieu"]
        jury = v["statut"] == "jury"
        sql(f"""INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location,
                                         location_precision, description, language, metadata_check, review_started_at,
                                         first_round_ratio, jury_since, jury_started_at, duration_s)
                VALUES ('{vid}', '{v["statut"]}', '{v["categorie"]}', '{v["sous"]}', '{v["forces"]}', '{v["situation"]}',
                        '{v["quand"]}', ST_GeogFromText('POINT({lon} {lat})'), '{v["precision"]}',
                        $${v["description"]}$$, 'fr', '{v["meta"]}', now() - interval '1 day',
                        {'0.55' if jury else 'NULL'}, {'now()' if jury else 'NULL'}, {'now()' if jury else 'NULL'}, 12)""")
        sql(f"""INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash)
                VALUES ('{vid}', 'Demo-{secrets.token_hex(2).upper()}-{n}', '\\x{secrets.token_hex(32)}')""")
        sql(f"""INSERT INTO core.summons (video_id, account_id, round, expires_at)
                VALUES ('{vid}', '{relecteur}', '{'jury' if jury else 'review'}', now() + interval '2 days')""")
        mire(FLOUTEES / vid, n)
        print(f"vidéo de démo {n} ({v['statut']}) : {vid}")

    publiques(ids)

    for i, constat, explication, liens in NOTES:
        tableau = "ARRAY[" + ", ".join(f"$${l}$$" for l in liens) + "]"
        sql(f"""SELECT core.osint_note_create('{analyste}', '{ids[i]}', $${constat}$$, $${explication}$$, {tableau}, true)""")
    print(f"{len(NOTES)} note(s) d'analyste ajoutée(s)")
    # Une correction de date et de lieu par demo_analyste, sur la vidéo du Vieux-Port.
    sql(f"""SELECT core.osint_correct_context('{analyste}', '{ids[2]}', '2026-11-01 01:40+01', false, 43.2951, 5.3740,
                   'approx_100m', $$La terrasse et l'enseigne visibles à 0:03 sont celles du quai de Rive-Neuve, côté sud
du port, et non côté nord. L'horloge de la place n'est pas lisible : heure inconnue.$$,
                   ARRAY['https://www.mapillary.com/app/?lat=43.2951&lng=5.374&z=18'])""")
    print("1 correction de date et de lieu ajoutée")
    print("Connexion : demo_relecteur / « demo argos relecteur » → page Relecture")


if __name__ == "__main__":
    main()
