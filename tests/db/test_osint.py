"""Notes d'analyse OSINT (0028) sur la base argos_test : statut d'analyste, notes, historique, masquage,
première impression des relecteurs."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from .test_relecture import nouveaux_comptes
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from test_relecture import nouveaux_comptes

LIENS = "ARRAY['https://www.mapillary.com/app/?pKey=123', 'https://exemple.fr/article']"


def admin() -> str:
    a = valeur("SELECT id FROM core.accounts WHERE is_superadmin")
    if not a:
        a, = nouveaux_comptes(1)
        valeur(f"UPDATE core.accounts SET is_superadmin = true WHERE id = '{a}'")
    return a


def double_auth(compte: str) -> None:
    valeur(f"INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('{compte}', 'totp', '\\x00')")


def statut(compte: str, accorder: bool = True, qui: str | None = None):
    return sql(f"SELECT core.admin_set_osint('{qui or admin()}', '{compte}', {str(accorder).lower()})", "argos_administration")


def analyste() -> str:
    a, = nouveaux_comptes(1)
    double_auth(a)
    r = statut(a)
    if r.returncode:
        raise AssertionError(r.stderr)
    return a


def video(status: str = "in_review") -> str:
    vid = str(uuid.uuid4())
    valeur(f"INSERT INTO core.videos (id, status, review_started_at) VALUES ('{vid}', '{status}', now())")
    return vid


def ecrire(compte: str, vid: str, constat: str = "Lieu confirmé : place de la République",
           liens: str = LIENS, public: bool = False):
    return sql(f"""SELECT core.osint_note_create('{compte}', '{vid}', '{constat}',
                   'Façade et mobilier urbain identiques sur Mapillary (2025).', {liens}, {str(public).lower()})""",
               "argos_app")


def id_note(compte: str, vid: str) -> str:
    ecrire(compte, vid)
    return valeur(f"SELECT id FROM core.osint_notes WHERE author_id = '{compte}' AND video_id = '{vid}' ORDER BY created_at DESC LIMIT 1")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestOsint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    # --- Statut ---------------------------------------------------------------------------------

    def test_statut_verifie_exige_la_double_auth(self):
        # 0102 : aucun statut vérifié sans double authentification active (le contrôle est forcé ici, car le
        # propriétaire de la base passe outre pour les données de démonstration et les tests).
        a, = nouveaux_comptes(1)
        inserer = f"""SET argos.forcer_controle = 'oui';
                     INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('{a}', 'journalist', now() + interval '1 year')"""
        self.assertIn("argos:double_auth_requise", sql(inserer).stderr)
        double_auth(a)
        self.assertEqual(sql(inserer).returncode, 0)

    def test_statut_accorde_par_le_super_admin_seulement(self):
        a, autre = nouveaux_comptes(2)
        self.assertIn("argos:reserve_super_admin", statut(a, qui=autre).stderr)
        self.assertIn("argos:double_auth_requise", statut(a).stderr)          # 2FA exigée
        double_auth(a)
        tete = valeur("SELECT coalesce(max(seq), 0) FROM ledger.entries")
        self.assertEqual(statut(a).returncode, 0)
        self.assertIn("argos:deja_ainsi", statut(a).stderr)
        self.assertEqual(valeur(f"SELECT core.is_osint_analyst('{a}')", "argos_app"), "t")
        # Inscrit au journal (en différé), sans le pseudo de l'analyste (0091).
        self.assertEqual(valeur(f"""SELECT string_agg(payload ->> 'action' || ':' || (payload ? 'analyst'), ',') FROM ledger.entries
                                     WHERE kind = 'admin_action' AND seq > {tete}
                                       AND payload ->> 'action' = 'osint_grant'"""), "osint_grant:false")
        self.assertEqual(statut(a, False).returncode, 0)
        self.assertEqual(valeur(f"SELECT core.is_osint_analyst('{a}')", "argos_app"), "f")
        self.assertIn("argos:deja_ainsi", statut(a, False).stderr)

    def test_statut_expire(self):
        a = analyste()
        valeur(f"""UPDATE core.verifications SET verified_at = now() - interval '2 years', expires_at = now() - interval '1 day'
                    WHERE account_id = '{a}' AND category = 'osint_analyst'""")
        self.assertEqual(valeur(f"SELECT core.is_osint_analyst('{a}')", "argos_app"), "f")
        self.assertEqual(statut(a).returncode, 0)                                # renouvellement
        self.assertEqual(valeur(f"SELECT core.is_osint_analyst('{a}')", "argos_app"), "t")

    # --- Notes ----------------------------------------------------------------------------------

    def test_ecrire_une_note(self):
        a, vid = analyste(), video()
        n = id_note(a, vid)
        self.assertEqual(valeur(f"SELECT version || ' ' || cardinality(links) FROM core.osint_notes WHERE id = '{n}'"), "1 2")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.osint_note_versions WHERE note_id = '{n}'"), "1")
        self.assertEqual(ecrire(a, video("jury")).returncode, 0)                 # jury aussi

    def test_qui_peut_ecrire_et_ou(self):
        simple, = nouveaux_comptes(1)
        self.assertIn("argos:reserve_analyste", ecrire(simple, video()).stderr)
        a = analyste()
        self.assertIn("argos:video_hors_relecture", ecrire(a, video("published")).stderr)
        valeur(f"UPDATE core.mfa_factors SET revoked_at = now() WHERE account_id = '{a}'")
        self.assertIn("argos:double_auth_requise", ecrire(a, video()).stderr)

    def test_contenu_verifie(self):
        a, vid = analyste(), video()
        self.assertIn("argos:note_invalide", ecrire(a, vid, constat="x" * 201).stderr)
        self.assertIn("argos:note_invalide", ecrire(a, vid, constat="   ").stderr)
        for mauvais in ("ARRAY[]::text[]", "ARRAY['http://exemple.fr']", "ARRAY['javascript:alert(1)']",
                        "ARRAY['https://user@exemple.fr/']", "ARRAY['https://localhost/']",
                        "ARRAY['https://exemple.fr/a b']",
                        "ARRAY[" + ", ".join(["'https://exemple.fr'"] * 11) + "]"):
            self.assertIn("argos:liens_invalides", ecrire(a, vid, liens=mauvais).stderr, mauvais)

    def test_trois_notes_au_plus(self):
        a, vid = analyste(), video()
        ids = [id_note(a, vid) for _ in range(3)]
        self.assertIn("argos:plafond_notes", ecrire(a, vid).stderr)
        valeur(f"SELECT core.osint_note_withdraw('{a}', '{ids[0]}')", "argos_app")
        self.assertEqual(ecrire(a, vid).returncode, 0)                           # une note retirée libère une place

    def test_correction_avec_historique(self):
        a, vid = analyste(), video()
        n = id_note(a, vid)
        corriger = lambda qui, constat, public="NULL": sql(
            f"""SELECT core.osint_note_edit('{qui}', '{n}', '{constat}',
                'Façade et mobilier urbain identiques sur Mapillary (2025).', {LIENS}, {public})""", "argos_app")
        self.assertEqual(corriger(a, "Lieu confirmé : place de la République, côté est").stdout.strip(), "2")
        self.assertEqual(corriger(a, "Lieu confirmé : place de la République, côté est", "true").stdout.strip(), "2")
        self.assertEqual(valeur(f"SELECT wants_public FROM core.osint_notes WHERE id = '{n}'"), "t")   # sans nouvelle version
        self.assertEqual(valeur(f"""SELECT string_agg(version::text, ',' ORDER BY version) FROM core.osint_note_versions
                                     WHERE note_id = '{n}'"""), "1,2")
        autre = analyste()
        self.assertIn("argos:note_introuvable", corriger(autre, "Pas ma note").stderr)
        valeur(f"SELECT core.osint_note_withdraw('{a}', '{n}')", "argos_app")
        self.assertIn("argos:note_introuvable", corriger(a, "Après retrait").stderr)

    def test_masquage_par_le_super_admin(self):
        a, vid = analyste(), video()
        n = id_note(a, vid)
        autre, = nouveaux_comptes(1)
        masquer = lambda qui, motif: sql(f"SELECT core.admin_mask_note('{qui}', '{n}', '{motif}')", "argos_administration")
        self.assertIn("argos:reserve_super_admin", masquer(autre, "Lien vers un site malveillant.").stderr)
        self.assertIn("argos:motif", masquer(admin(), "court").stderr)
        self.assertEqual(masquer(admin(), "Lien vers un site malveillant.").returncode, 0)
        self.assertEqual(valeur(f"""SELECT payload ->> 'reason' FROM ledger.entries WHERE kind = 'admin_action'
                                     AND payload ->> 'note' = '{n}'"""), "Lien vers un site malveillant.")
        self.assertIn("argos:note_introuvable", masquer(admin(), "Lien vers un site malveillant.").stderr)

    def test_le_site_ne_peut_pas_ecrire_directement(self):
        a, vid = analyste(), video()
        n = id_note(a, vid)
        self.assertIn(REFUSE, sql(f"UPDATE core.osint_notes SET finding = 'x' WHERE id = '{n}'", "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"DELETE FROM core.osint_note_versions WHERE note_id = '{n}'", "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"""INSERT INTO core.verifications (account_id, category, expires_at)
                                      VALUES ('{a}', 'osint_analyst', now() + interval '1 year')""", "argos_app").stderr)

    # --- Première impression ----------------------------------------------------------------------

    def test_ouverture_de_la_video_notee_une_fois(self):
        vid = video()
        compte, = nouveaux_comptes(1)
        sid = str(uuid.uuid4())
        valeur(f"""INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                   VALUES ('{sid}', '{vid}', '{compte}', 'review', now() + interval '2 days')""")
        ouvrir = f"UPDATE core.summons SET video_opened_at = now() WHERE id = '{sid}'"
        self.assertEqual(sql(ouvrir, "argos_app").returncode, 0)
        self.assertIn("interdit", sql(f"UPDATE core.summons SET video_opened_at = NULL WHERE id = '{sid}'", "argos_app").stderr)
        self.assertIn("interdit", sql(ouvrir, "argos_app").stderr)              # pas de seconde date
        self.assertEqual(sql(f"UPDATE core.summons SET outcome = 'passed', answered_at = now() WHERE id = '{sid}'",
                             "argos_app").returncode, 0)                          # passer reste possible


if __name__ == "__main__":
    unittest.main()
