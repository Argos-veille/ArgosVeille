"""Jugement des notes OSINT (0029) : seulement après son vote, camp retrouvé par la base, mise en avant
« bridging », fiche publique, et le site ne lit jamais les jugements un par un."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from .test_relecture import nouveaux_comptes, voter
    from .test_osint import analyste, id_note, video
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from test_relecture import nouveaux_comptes, voter
    from test_osint import analyste, id_note, video

RAISONS = {"yes": "ARRAY['reliable_sources']", "somewhat": "ARRAY['clear', 'dead_links']", "no": "ARRAY['opinion']"}


def votant(vid: str, verdict: str) -> tuple[str, str]:
    """Un compte qui a voté sur la vidéo ; renvoie (compte, convocation)."""
    c, = nouveaux_comptes(1)
    r = voter(vid, c, verdict)
    if r.returncode:
        raise AssertionError(r.stderr)
    return c, valeur(f"SELECT id FROM core.summons WHERE video_id = '{vid}' AND account_id = '{c}'")


def juger(qui: tuple[str, str], note: str, avis: str, raisons: str | None = None):
    return sql(f"SELECT core.rate_note('{qui[0]}', '{qui[1]}', '{note}', '{avis}', {raisons or RAISONS[avis]})", "argos_app")


def etat(note: str) -> str:
    return valeur(f"SELECT core.note_state('{note}')", "argos_app")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestJugementNotes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def setUp(self):
        self.vid = video()
        self.auteur = analyste()
        self.note = id_note(self.auteur, self.vid)

    def camps(self, oui: list[str], non: list[str]) -> None:
        for avis in oui:
            self.assertEqual(juger(votant(self.vid, "valid"), self.note, avis).returncode, 0)
        for avis in non:
            self.assertEqual(juger(votant(self.vid, "invalid"), self.note, avis).returncode, 0)

    def test_juger_seulement_apres_son_vote(self):
        c, = nouveaux_comptes(1)
        sid = str(uuid.uuid4())
        valeur(f"""INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                   VALUES ('{sid}', '{self.vid}', '{c}', 'review', now() + interval '2 days')""")
        self.assertIn("argos:sans_vote", juger((c, sid), self.note, "yes").stderr)
        autre = votant(self.vid, "valid")
        self.assertIn("argos:sans_vote", juger((c, autre[1]), self.note, "yes").stderr)   # la convocation d'un autre

    def test_raisons_propres_a_l_avis(self):
        v = votant(self.vid, "valid")
        self.assertIn("23514", juger(v, self.note, "yes", "ARRAY['opinion']").stderr)
        self.assertIn("23514", juger(v, self.note, "no", "ARRAY[]::text[]").stderr)
        self.assertEqual(juger(v, self.note, "somewhat").returncode, 0)

    def test_raisons_contradictoires_refusees(self):
        v = votant(self.vid, "valid")
        self.assertIn("23514", juger(v, self.note, "somewhat", "ARRAY['reliable_sources', 'dubious_sources']").stderr)
        self.assertEqual(juger(v, self.note, "somewhat", "ARRAY['reliable_sources', 'dead_links']").returncode, 0)

    def test_changer_d_avis_et_pas_sa_propre_note(self):
        v = votant(self.vid, "valid")
        juger(v, self.note, "no")
        juger(v, self.note, "yes")
        self.assertEqual(valeur(f"SELECT helpful FROM core.my_note_ratings('{v[0]}', '{v[1]}')", "argos_app"), "yes")
        r = voter(self.vid, self.auteur, "valid")
        self.assertEqual(r.returncode, 0)
        sid = valeur(f"SELECT id FROM core.summons WHERE video_id = '{self.vid}' AND account_id = '{self.auteur}'")
        self.assertIn("argos:propre_note", juger((self.auteur, sid), self.note, "yes").stderr)

    def test_mise_en_avant_par_les_deux_camps(self):
        self.camps(["yes"] * 3, ["yes", "yes"])
        self.assertEqual(etat(self.note), "needs_ratings")      # un seul camp suffisamment représenté
        self.camps([], ["somewhat"])                             # non : 2,5 / 3 ≥ 2/3
        self.assertEqual(etat(self.note), "featured")
        self.assertEqual(valeur(f"SELECT core.analyst_featured_notes('{self.auteur}')", "argos_app"), "1")

    def test_un_seul_camp_ne_suffit_pas(self):
        self.camps(["yes"] * 10, ["no"] * 3)
        self.assertEqual(etat(self.note), "needs_ratings")

    def test_peu_utile_pour_les_deux_camps(self):
        self.camps(["no"] * 3, ["no", "no", "somewhat"])
        self.assertEqual(etat(self.note), "unhelpful")

    def test_en_partie_sur_la_video_sans_camp(self):
        for _ in range(3):
            juger(votant(self.vid, "partly"), self.note, "yes")
        self.camps(["yes"] * 3, [])
        self.assertEqual(etat(self.note), "needs_ratings")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.note_ratings WHERE note_id = '{self.note}' AND side IS NULL"), "3")

    def test_fiche_publique(self):
        publique = lambda: valeur(f"SELECT count(*) FROM core.public_notes('{self.vid}')", "argos_app")
        valeur(f"SELECT core.osint_note_edit('{self.auteur}', '{self.note}', 'Lieu confirmé : place de la République', "
               f"'Façade et mobilier urbain identiques sur Mapillary (2025).', "
               f"ARRAY['https://www.mapillary.com/app/?pKey=123', 'https://exemple.fr/article'], true)", "argos_app")
        id_note(analyste(), self.vid)                             # sans le choix de son auteur : jamais publique
        self.camps(["yes"] * 3, ["yes"] * 3)
        self.assertEqual(publique(), "0")                         # vidéo pas encore publiée
        valeur(f"UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '{self.vid}'")
        self.assertEqual(publique(), "1")

    def test_fiche_publique_sans_note_peu_utile(self):
        valeur(f"UPDATE core.osint_notes SET wants_public = true WHERE id = '{self.note}'")
        self.camps(["no"] * 3, ["no"] * 3)
        valeur(f"UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '{self.vid}'")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.public_notes('{self.vid}')", "argos_app"), "0")

    def test_le_site_ne_lit_pas_les_jugements(self):
        self.assertIn(REFUSE, sql("SELECT * FROM core.note_ratings", "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"DELETE FROM core.note_ratings WHERE note_id = '{self.note}'", "argos_app").stderr)


if __name__ == "__main__":
    unittest.main()
