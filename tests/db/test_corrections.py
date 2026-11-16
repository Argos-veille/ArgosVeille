"""Corrections de la date, de l'heure et du lieu par les analystes OSINT (0036) : appliquées tout de suite,
déclaration de la source gardée, journal public, annulation par le super-administrateur (la dernière d'abord)."""
import unittest

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from .test_relecture import nouveaux_comptes
    from .test_osint import admin, analyste, ecrire, video
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from test_relecture import nouveaux_comptes
    from test_osint import admin, analyste, ecrire, video

LIENS = "ARRAY['https://www.mapillary.com/app/?pKey=42']"


def corriger(compte: str, vid: str, quand: str = "2026-10-28 15:40+01", heure: str = "true", lat: float = 48.8673,
             lon: float = 2.3631, precision: str = "approx_100m", justification: str = "Bouche de métro visible à 0:04.",
             liens: str = LIENS):
    return sql(f"""SELECT core.osint_correct_context('{compte}', '{vid}', '{quand}', {heure}, {lat}, {lon}, '{precision}',
                   '{justification}', {liens})""", "argos_app")


def etat(vid: str) -> str:
    return valeur(f"""SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || '|' || occurred_time_known || '|'
                             || round(ST_Y(location::geometry)::numeric, 4) || '|' || coalesce(location_precision, '-')
                        FROM core.videos WHERE id = '{vid}'""")


def video_placee() -> str:
    vid = video()
    valeur(f"""UPDATE core.videos SET occurred_at = '2026-10-29 10:00+00', location = ST_GeogFromText('POINT(2.35 48.85)'),
                      location_precision = 'municipality' WHERE id = '{vid}'""")
    return vid


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestCorrections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_correction_appliquee_et_declaration_gardee(self):
        a, vid = analyste(), video_placee()
        avant = etat(vid)
        self.assertEqual(corriger(a, vid, heure="false").returncode, 0)
        # La source avait choisi « commune » : la précision y est ramenée et le point arrondi (0092).
        self.assertEqual(etat(vid), "2026-10-28 14:40|false|48.8700|municipality")
        self.assertEqual(valeur(f"""SELECT to_char(declared_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || '|'
                                           || declared_location_precision FROM core.videos WHERE id = '{vid}'"""),
                         "2026-10-29 10:00|municipality")
        self.assertTrue(avant.startswith("2026-10-29 10:00"))
        corriger(analyste(), vid, quand="2026-10-28 15:50+01")   # 2e correction : la déclaration ne bouge plus
        self.assertEqual(valeur(f"SELECT declared_location_precision FROM core.videos WHERE id = '{vid}'"), "municipality")
        self.assertEqual(valeur(f"""SELECT count(*) FROM ledger.entries WHERE kind = 'correction'
                                     AND payload ->> 'video' = '{vid}'"""), "2")

    def test_jamais_plus_precis_que_la_source_sauf_lieu_a_etablir(self):
        a, vid = analyste(), video_placee()
        valeur(f"UPDATE core.videos SET location_precision = 'approx_100m' WHERE id = '{vid}'")
        self.assertEqual(corriger(a, vid, lat=48.86734, precision="exact").returncode, 0)
        self.assertEqual(etat(vid), "2026-10-28 14:40|true|48.8670|approx_100m")
        self.assertEqual(corriger(a, vid, lat=48.86734, precision="municipality").returncode, 0)   # moins précis : accepté
        self.assertEqual(etat(vid).split("|")[3], "municipality")
        # À précision égale ou moindre, le point est arrondi par la base elle-même (0109), pas seulement par le site.
        self.assertEqual(corriger(a, vid, lat=48.867349, lon=2.363149, precision="approx_100m").returncode, 0)
        self.assertEqual(valeur(f"SELECT ST_Y(location::geometry) || '|' || ST_X(location::geometry) FROM core.videos WHERE id = '{vid}'"),
                         "48.867|2.363")
        # Lieu à établir (la source ne connaissait pas le lieu) : l'analyste peut l'établir précisément, et le corriger ensuite.
        libre = video_placee()
        valeur(f"UPDATE core.videos SET location_to_establish = true WHERE id = '{libre}'")
        self.assertEqual(sql(f"""SELECT core.osint_correct_context('{a}', '{libre}', '2026-10-28 15:40+01', true, 48.86734, 2.3631,
                               'exact', 'Bouche de métro visible à 0:04.', {LIENS}, false, true)""", "argos_app").returncode, 0)
        self.assertEqual(etat(libre), "2026-10-28 14:40|true|48.8673|exact")
        self.assertEqual(corriger(a, libre, lat=48.86741, precision="exact").returncode, 0)
        self.assertEqual(etat(libre).split("|")[3], "exact")

    def test_qui_peut_corriger_et_contenu(self):
        simple, = nouveaux_comptes(1)
        self.assertIn("argos:reserve_analyste", corriger(simple, video_placee()).stderr)
        a = analyste()
        self.assertIn("argos:video_hors_relecture", corriger(a, video("published")).stderr)
        vid = video_placee()
        self.assertIn("argos:justification", corriger(a, vid, justification="court").stderr)
        self.assertIn("argos:liens_invalides", corriger(a, vid, liens="ARRAY['http://exemple.fr']").stderr)
        self.assertIn("argos:date_invalide", corriger(a, vid, quand="2099-01-01 00:00+00").stderr)
        self.assertIn("argos:lieu_invalide", corriger(a, vid, precision="partout").stderr)
        self.assertIn(REFUSE, sql(f"UPDATE core.videos SET occurred_at = now() WHERE id = '{vid}'", "argos_app").stderr)

    def test_annulation_la_derniere_d_abord(self):
        a, vid = analyste(), video_placee()
        valeur(f"UPDATE core.videos SET location_precision = 'approx_100m' WHERE id = '{vid}'")   # pas de plafond en jeu ici
        corriger(a, vid, quand="2026-10-28 15:40+01")
        corriger(a, vid, quand="2026-10-27 09:00+01", lat=48.9)
        premiere, seconde = valeur(f"""SELECT string_agg(id::text, ' ' ORDER BY created_at)
                                         FROM core.context_corrections WHERE video_id = '{vid}'""").split()
        annuler = lambda qui, c, motif="Sources ne montrant pas ce lieu.": sql(
            f"SELECT core.admin_cancel_correction('{qui}', '{c}', '{motif}')", "argos_administration")
        self.assertIn("argos:reserve_super_admin", annuler(a, seconde).stderr)
        self.assertIn("argos:motif", annuler(admin(), seconde, "court").stderr)
        self.assertIn("argos:correction_pas_la_derniere", annuler(admin(), premiere).stderr)
        self.assertEqual(annuler(admin(), seconde).returncode, 0)
        self.assertEqual(etat(vid), "2026-10-28 14:40|true|48.8670|approx_100m")   # retour à la 1re correction (arrondie à 3 décimales, 0109)
        self.assertEqual(annuler(admin(), premiere).returncode, 0)
        self.assertEqual(etat(vid), "2026-10-29 10:00|true|48.8500|approx_100m")   # retour à la déclaration
        self.assertIn("argos:correction_introuvable", annuler(admin(), premiere).stderr)
        self.assertEqual(valeur(f"""SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action'
                                     AND payload ->> 'action' = 'cancel_correction' AND payload ->> 'video' = '{vid}'"""), "2")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestLieuDateAEtablir(unittest.TestCase):
    """Lieu ou date inconnus à l'envoi (0086) : publiée par la relecture → en attente d'analyse ; publiée quand
    un analyste a établi tout ce qui manquait ; l'administration peut publier sans attendre."""

    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def a_etablir(self, date: bool = True, lieu: bool = True) -> str:
        vid = video_placee()
        valeur(f"UPDATE core.videos SET date_to_establish = {date}, location_to_establish = {lieu} WHERE id = '{vid}'")
        return vid

    def statut(self, vid: str) -> str:
        return valeur(f"SELECT status FROM core.videos WHERE id = '{vid}'")

    def corriger_etablit(self, vid: str, date: bool, lieu: bool):
        return sql(f"""SELECT core.osint_correct_context('{analyste()}', '{vid}', '2026-10-28 15:40+01', true, 48.8673, 2.3631,
                       'approx_100m', 'Bouche de métro visible à 0:04.', {LIENS}, {date}, {lieu})""", "argos_app")

    def test_publiee_par_la_relecture_attend_l_analyse(self):
        vid = self.a_etablir()
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        self.assertEqual(self.statut(vid), "awaiting_osint")
        self.assertEqual(valeur(f"""SELECT payload ->> 'status' FROM ledger.entries WHERE kind = 'decision'
                                     AND payload ->> 'video' = '{vid}'"""), "awaiting_osint")
        # Sans rien à établir, la publication reste directe.
        normale = video_placee()
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{normale}'")
        self.assertEqual(self.statut(normale), "published")

    def test_publiee_quand_tout_est_etabli(self):
        vid = self.a_etablir()
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        self.assertEqual(self.corriger_etablit(vid, True, False).returncode, 0)
        self.assertEqual(self.statut(vid), "awaiting_osint")   # le lieu manque encore
        self.assertEqual(self.corriger_etablit(vid, False, True).returncode, 0)
        self.assertEqual(self.statut(vid), "published")
        self.assertEqual(valeur(f"""SELECT date_to_establish OR location_to_establish FROM core.videos WHERE id = '{vid}'"""), "f")

    def test_correction_en_relecture_leve_l_attente(self):
        vid = self.a_etablir(date=False)
        self.assertEqual(self.corriger_etablit(vid, False, True).returncode, 0)
        self.assertEqual(self.statut(vid), "in_review")
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        self.assertEqual(self.statut(vid), "published")

    def test_l_administration_publie_sans_attendre(self):
        vid = self.a_etablir()
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        r = sql(f"SELECT core.admin_decide('{admin()}', '{vid}', 'publish', 'Lieu confirmé par la source par message.')", "argos_administration")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.statut(vid), "published")

    def test_tableau_de_bord(self):
        avant = valeur(f"SELECT core.admin_dashboard_osint('{admin()}') ->> 'enAttente'")
        vid = self.a_etablir()
        valeur(f"UPDATE core.videos SET status = 'published', decided_at = now() WHERE id = '{vid}'")
        t = valeur(f"""SELECT (o ->> 'enAttente') || '|' || (o ->> 'plusAncienne' IS NOT NULL) || '|' || (o ->> 'arrivees30j')::int
                         FROM core.admin_dashboard_osint('{admin()}') o""").split("|")
        self.assertEqual(int(t[0]), int(avant) + 1)
        self.assertEqual(t[1], "true")
        self.assertGreaterEqual(int(t[2]), 1)
        simple, = nouveaux_comptes(1)
        self.assertIn("argos:reserve_super_admin", sql(f"SELECT core.admin_dashboard_osint('{simple}')", "argos_administration").stderr)


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestFinitionsP1(unittest.TestCase):
    """0088 : recours au tableau de bord, certification retirée avec le dernier statut, annulation qui remet
    « à établir », notes permises en attente d'analyse."""

    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_annuler_la_correction_remet_a_etablir(self):
        vid = video_placee()
        valeur(f"UPDATE core.videos SET date_to_establish = true, location_to_establish = true WHERE id = '{vid}'")
        valeur(f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        r = sql(f"""SELECT core.osint_correct_context('{analyste()}', '{vid}', '2026-10-28 15:40+01', true, 48.8673, 2.3631,
                    'approx_100m', 'Bouche de métro visible à 0:04.', {LIENS}, true, true)""", "argos_app")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(valeur(f"SELECT status FROM core.videos WHERE id = '{vid}'"), "published")
        c = valeur(f"SELECT id FROM core.context_corrections WHERE video_id = '{vid}'")
        r = sql(f"SELECT core.admin_cancel_correction('{admin()}', '{c}', 'Sources ne montrant pas ce lieu.')", "argos_administration")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(valeur(f"""SELECT status || '|' || date_to_establish || '|' || location_to_establish
                                      FROM core.videos WHERE id = '{vid}'"""), "awaiting_osint|true|true")

    def test_note_permise_en_attente_d_analyse(self):
        vid = video("awaiting_osint")
        r = ecrire(analyste(), vid)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_retrait_du_dernier_statut_retire_la_certification(self):
        compte, = nouveaux_comptes(1)
        statut = lambda s, g: sql(f"SELECT core.admin_set_status('{admin()}', '{compte}', '{s}', {g})", "argos_administration")
        certifie = lambda: valeur(f"SELECT certified FROM core.accounts WHERE id = '{compte}'")
        self.assertEqual(statut('journalist', 'true').returncode, 0)
        self.assertEqual(statut('lawyer', 'true').returncode, 0)
        self.assertEqual(certifie(), "t")
        statut('journalist', 'false')
        self.assertEqual(certifie(), "t")   # avocat encore actif
        statut('lawyer', 'false')
        self.assertEqual(certifie(), "f")

    def test_recours_au_tableau_de_bord(self):
        avant = int(valeur(f"SELECT core.admin_dashboard_recours('{admin()}') ->> 'sansDecision'"))
        video("no_decision")
        self.assertEqual(int(valeur(f"SELECT core.admin_dashboard_recours('{admin()}') ->> 'sansDecision'")), avant + 1)


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestNotesAdmin(unittest.TestCase):
    """0089 : notes privées du super-administrateur."""

    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_ajouter_modifier_supprimer(self):
        a = admin()
        nid = valeur(f"SELECT core.admin_note_save('{a}', NULL, 'Renouveler le domaine', '2027-03-01', NULL)")
        self.assertEqual(valeur(f"SELECT title || '|' || due_date FROM core.admin_notes WHERE id = '{nid}'"), "Renouveler le domaine|2027-03-01")
        valeur(f"SELECT core.admin_note_save('{a}', '{nid}', 'Renouveler le domaine argos', NULL, 'Chez le registraire')")
        self.assertEqual(valeur(f"SELECT title || '|' || coalesce(due_date::text, '-') || '|' || details FROM core.admin_notes WHERE id = '{nid}'"),
                         "Renouveler le domaine argos|-|Chez le registraire")
        simple, = nouveaux_comptes(1)
        self.assertIn("argos:reserve_super_admin", sql(f"SELECT core.admin_notes_list('{simple}')", "argos_administration").stderr)
        self.assertIn("argos:details", sql(f"SELECT core.admin_note_save('{a}', NULL, '  ', NULL, NULL)", "argos_administration").stderr)
        self.assertEqual(valeur(f"SELECT core.admin_note_delete('{a}', '{nid}')"), "t")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.admin_notes WHERE id = '{nid}'"), "0")
