"""Même événement (0070) : propositions, réponses des relecteurs à 65 %, groupes fusionnés, droits."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur


def video(statut: str = "published") -> str:
    vid = str(uuid.uuid4())
    valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', '{statut}')")
    return vid


def relier(a: str, b: str) -> None:
    valeur(f"SELECT core.link_event('{a}', '{b}')")


def groupe(v: str) -> list[str]:
    return valeur(f"SELECT id FROM core.public_event_videos('{v}')", "argos_app").splitlines()


def proposition(a: str, b: str) -> str:
    return valeur(f"SELECT core.propose_event('{a}', '{b}', 'reviewer', NULL, NULL)")


def reponses(p: str, video_id: str, *oui_poids: tuple) -> None:
    for oui, poids in oui_poids:
        s, compte = str(uuid.uuid4()), str(uuid.uuid4())
        valeur(f"""INSERT INTO core.accounts (id, username, status, score) VALUES ('{compte}', 'e_{compte[:12]}', 'active', 1);
                   INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES ('{s}', '{video_id}', '{compte}', 'review', now() + interval '1 day');
                   BEGIN; ALTER TABLE core.votes DISABLE TRIGGER USER;
                   INSERT INTO core.votes (id, summons_id, video_id, round, verdict, reasons, is_valid, answers, weight)
                   VALUES ('{s}', '{s}', '{video_id}', 'review', 'valid', '{{intervention_visible}}', true, '{{}}', {poids});
                   ALTER TABLE core.votes ENABLE TRIGGER USER; COMMIT;
                   INSERT INTO core.event_proposal_answers (proposal_id, vote_id, agrees, weight) VALUES ('{p}', '{s}', {oui}, {poids})""")


def statut(p: str) -> str:
    return valeur(f"SELECT status FROM core.event_proposals WHERE id = '{p}'")


def fin_du_tour(v: str) -> None:
    valeur(f"UPDATE core.videos SET status = 'rejected', decided_at = now() WHERE id = '{v}'")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestMemeEvenement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_tables_illisibles_par_le_site(self):
        for table in ("event_proposals", "event_proposal_answers", "event_proposal_reviews"):
            self.assertIn(REFUSE, sql(f"SELECT * FROM core.{table}", "argos_app").stderr, table)

    def test_groupes_fusionnes(self):
        a, b, c, d = video(), video(), video(), video()
        relier(a, b)
        relier(c, d)
        relier(b, c)
        self.assertEqual(sorted(groupe(a)), sorted([b, c, d]))

    def test_seules_les_videos_publiees_apparaissent(self):
        a, b, c = video(), video(), video("in_review")
        relier(a, b)
        relier(a, c)
        self.assertEqual(groupe(a), [b])

    def test_proposition_vers_une_video_non_publiee_refusee(self):
        self.assertEqual(valeur(f"SELECT core.propose_event('{video()}', '{video('in_review')}', 'source', NULL, NULL)"), "")

    def test_source_seulement_a_l_envoi(self):
        f = video()
        envoi, deja = str(uuid.uuid4()), video("in_review")
        valeur(f"INSERT INTO core.videos (id, status, upload_expires_at) VALUES ('{envoi}', 'uploading', now() + interval '1 day')")
        valeur(f"SELECT core.source_propose_event('{envoi}', '{f}')", "argos_app")
        valeur(f"SELECT core.source_propose_event('{deja}', '{f}')", "argos_app")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.event_proposals WHERE video_id = '{envoi}' AND origin = 'source'"), "1")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.event_proposals WHERE video_id = '{deja}'"), "0")

    def test_une_seule_proposition_par_paire(self):
        a, b = video(), video()
        self.assertEqual(proposition(a, b), proposition(b, a))

    def test_valide_a_65_pour_cent_avec_3_reponses(self):
        v, f = video("in_review"), video()
        p = proposition(v, f)
        reponses(p, v, (True, 3), (True, 4), (False, 3))
        fin_du_tour(v)
        self.assertEqual(statut(p), "validated")

    def test_sans_majorite_reste_en_attente(self):
        v, f = video("in_review"), video()
        p = proposition(v, f)
        reponses(p, v, (True, 5), (False, 5), (True, 1))
        fin_du_tour(v)
        self.assertEqual(statut(p), "pending")

    def test_moins_de_3_reponses_reste_en_attente(self):
        v, f = video("in_review"), video()
        p = proposition(v, f)
        reponses(p, v, (True, 5), (True, 5))
        fin_du_tour(v)
        self.assertEqual(statut(p), "pending")

    def test_refus_net(self):
        v, f = video("in_review"), video()
        p = proposition(v, f)
        reponses(p, v, (False, 5), (False, 5), (True, 1))
        fin_du_tour(v)
        self.assertEqual(statut(p), "refused")

    def test_retrait_par_la_source_efface_liens_et_propositions(self):
        a, b, c = video(), video(), video("in_review")
        relier(a, b)
        p = proposition(c, a)
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{b}'")
        self.assertEqual(groupe(a), [])
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{c}'")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.event_proposals WHERE id = '{p}'"), "0")

    def test_suggestions_lieu_et_date(self):
        def placee(lon: float, quand: str, connue: str = "true", statut_v: str = "published") -> str:
            v = video(statut_v)
            valeur(f"""UPDATE core.videos SET occurred_at = '{quand}', occurred_time_known = {connue},
                       location = ST_GeogFromText('POINT({lon} 45.123)'), location_precision = 'approx_100m' WHERE id = '{v}'""")
            return v
        q = placee(5.0, "2026-11-01 15:00+00", statut_v="in_review")
        proche = placee(5.002, "2026-11-01 16:00+00")           # environ 160 m, 1 h
        tard = placee(5.002, "2026-11-01 19:00+00")             # 4 h d'écart, heures connues
        loin = placee(5.02, "2026-11-01 15:00+00")              # environ 1,6 km
        sans_heure = placee(5.002, "2026-11-01 20:00+00", "false")   # même jour, heure inconnue
        s = valeur(f"SELECT id FROM core.event_suggestions('{q}', 10)").splitlines()
        self.assertIn(proche, s)
        self.assertIn(sans_heure, s)
        self.assertNotIn(tard, s)
        self.assertNotIn(loin, s)
