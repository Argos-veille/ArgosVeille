"""Tests du schéma sur la base argos_test (ignorés si la base n'est pas joignable).

Ils vérifient surtout la sécurité : ce que chaque rôle peut et ne peut PAS faire.
"""
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "db"))
import migrate  # noqa: E402

DB = "argos_test"

# Codes SQLSTATE standard (indépendants de la langue du serveur)
REFUSE = "42501"       # accès refusé
CONTRAINTE = "23514"   # contrainte de vérification violée
DOUBLON = "23505"      # valeur unique déjà présente


def sql(requete: str, role: str | None = None) -> subprocess.CompletedProcess:
    # Lecture du journal : on inscrit d'abord les entrées différées (0091), comme le moteur le ferait dans les 24 heures.
    if "ledger.entries" in requete and "flush_pending" not in requete:
        migrate.psql(DB, "SELECT ledger.flush_pending(true)")
    if role:
        requete = f"SET ROLE {role}; {requete}"
    return migrate.psql(DB, requete)


def valeur(requete: str, role: str | None = None) -> str:
    r = sql(requete, role)
    if r.returncode:
        raise AssertionError(r.stderr)
    return r.stdout.strip()


def base_disponible() -> bool:
    try:
        return migrate.psql(DB, "SELECT 1").returncode == 0
    except (FileNotFoundError, OSError):
        return False


@unittest.skipUnless(base_disponible(), "base argos_test non joignable (voir db/setup_dev.sql)")
class TestSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.reinitialiser(DB)
        migrate.migrer(DB)
        # Données de test : deux comptes, une vidéo en relecture, une convocation.
        valeur("""
            INSERT INTO core.accounts (id, username, created_at, is_superadmin) VALUES
                ('00000000-0000-0000-0000-00000000000a', 'Admin', now() - interval '100 days', true),
                ('00000000-0000-0000-0000-00000000000b', 'Relecteur_B', now(), false);
            INSERT INTO identity.account_identities (account_id, phone_hmac, email_hmac, email_enc)
                VALUES ('00000000-0000-0000-0000-00000000000a', '\\x01', '\\x02', '\\x03');
            INSERT INTO core.videos (id, status, location, location_precision) VALUES
                ('00000000-0000-0000-0000-0000000000f1', 'in_review',
                 ST_GeogFromText('POINT(2.3522 48.8566)'), 'exact'),
                ('00000000-0000-0000-0000-0000000000f2', 'in_review',
                 ST_GeogFromText('POINT(2.3530 48.8570)'), 'approx_100m');
            INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash) VALUES
                ('00000000-0000-0000-0000-0000000000f1', 'Heron-Ambre-4821', sha256('code de suivi f1'));
            INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES
                ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
                 '00000000-0000-0000-0000-00000000000b', 'review', now() + interval '2 days');
        """)

    # --- Cloisonnement de l'identité -----------------------------------------

    def test_site_public_ne_lit_pas_l_identite(self):
        r = sql("SELECT * FROM identity.account_identities", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_seul_le_role_identite_lit_l_identite(self):
        self.assertEqual(valeur("SELECT count(*) FROM identity.account_identities WHERE phone_hmac = '\\x01'",
                                "argos_identity"), "1")
        for role in ("argos_worker", "argos_scoring", "argos_admin"):
            with self.subTest(role=role):
                self.assertIn(REFUSE, sql("SELECT * FROM identity.account_identities", role).stderr)

    def test_bannissement_survit_a_la_suppression_du_compte(self):
        valeur("""INSERT INTO core.accounts (id, username) VALUES ('00000000-0000-0000-0000-0000000000dd', 'Banni');
                  INSERT INTO identity.account_identities (account_id, phone_hmac, email_hmac, email_enc, banned)
                  VALUES ('00000000-0000-0000-0000-0000000000dd', '\\x0d', '\\x0e', '\\x0f', true);
                  DELETE FROM core.accounts WHERE id = '00000000-0000-0000-0000-0000000000dd';""")
        self.assertEqual(valeur("SELECT banned FROM identity.account_identities WHERE phone_hmac = '\\x0d'"), "t")
        r = sql("INSERT INTO identity.account_identities (phone_hmac, email_hmac, email_enc) "
                "VALUES ('\\x0d', '\\x1e', '\\x1f')")
        self.assertIn(DOUBLON, r.stderr)   # impossible de se réinscrire avec le même numéro

    # --- Lien compte-vidéo et votes ------------------------------------------

    def test_aucune_table_ne_relie_une_video_a_un_compte(self):
        """Protection des sources : ni les pseudonymes ni les vidéos n'ont de colonne vers un compte."""
        self.assertEqual(valeur("""
            SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'core' AND table_name IN ('pseudonyms', 'videos')
               AND column_name LIKE '%account%'"""), "0")
        # Aucune clé étrangère de ces deux tables vers les comptes.
        self.assertEqual(valeur("""
            SELECT count(*) FROM pg_constraint
             WHERE contype = 'f' AND confrelid = 'core.accounts'::regclass
               AND conrelid IN ('core.pseudonyms'::regclass, 'core.videos'::regclass)"""), "0")

    def test_video_retrouvee_par_son_code_de_suivi(self):
        self.assertEqual(valeur("SELECT pseudonym FROM core.pseudonyms "
                                "WHERE tracking_code_hash = sha256('code de suivi f1')", "argos_app"),
                         "Heron-Ambre-4821")
        self.assertEqual(valeur("SELECT count(*) FROM core.pseudonyms "
                                "WHERE tracking_code_hash = sha256('mauvais code')", "argos_app"), "0")

    def test_code_de_suivi_obligatoire_unique_et_bien_forme(self):
        valeur("""INSERT INTO core.videos (id, status, location, location_precision) VALUES
                  ('00000000-0000-0000-0000-0000000000f9', 'processing', ST_GeogFromText('POINT(2.35 48.85)'), 'exact')""")
        r = sql("INSERT INTO core.pseudonyms (video_id, pseudonym) "
                "VALUES ('00000000-0000-0000-0000-0000000000f9', 'Loup-Gris-1111')", "argos_app")
        self.assertIn("23502", r.stderr)   # valeur NULL interdite
        r = sql("INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash) "
                "VALUES ('00000000-0000-0000-0000-0000000000f9', 'Loup-Gris-1111', '\\x01')", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)   # pas une empreinte SHA-256
        r = sql("INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash) "
                "VALUES ('00000000-0000-0000-0000-0000000000f9', 'Loup-Gris-1111', sha256('code de suivi f1'))",
                "argos_app")
        self.assertIn(DOUBLON, r.stderr)

    def test_le_calcul_des_scores_ne_voit_pas_les_codes_de_suivi(self):
        self.assertEqual(valeur("SELECT pseudonym FROM core.pseudonyms", "argos_scoring"), "Heron-Ambre-4821")
        self.assertIn(REFUSE, sql("SELECT tracking_code_hash FROM core.pseudonyms", "argos_scoring").stderr)

    # --- Pseudo et mail des relecteurs ---------------------------------------

    def test_pseudo_unique_sans_tenir_compte_de_la_casse(self):
        r = sql("INSERT INTO core.accounts (username) VALUES ('relecteur_b')", "argos_app")
        self.assertIn(DOUBLON, r.stderr)

    def test_pseudo_mal_forme_refuse(self):
        for pseudo in ("ab", "x" * 31, "avec espace", "<script>", "a'b"):
            with self.subTest(pseudo=pseudo):
                r = sql(f"INSERT INTO core.accounts (username) VALUES ($${pseudo}$$)", "argos_app")
                self.assertIn(CONTRAINTE, r.stderr)
        valeur("INSERT INTO core.accounts (username) VALUES ('Héron.Ambré-42')", "argos_app")

    def test_le_site_cree_un_compte_avec_son_pseudo_seulement(self):
        r = sql("INSERT INTO core.accounts (username, is_superadmin) VALUES ('Intrus', true)", "argos_app")
        self.assertIn(REFUSE, r.stderr)
        r = sql("INSERT INTO core.accounts (username, score) VALUES ('Intrus', 10)", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_mail_obligatoire_unique_et_isole(self):
        r = sql("INSERT INTO identity.account_identities (phone_hmac, email_enc) VALUES ('\\x21', '\\x22')",
                "argos_identity")
        self.assertIn("23502", r.stderr)   # empreinte du mail obligatoire
        r = sql("INSERT INTO identity.account_identities (phone_hmac, email_hmac) VALUES ('\\x21', '\\x23')",
                "argos_identity")
        self.assertIn("23502", r.stderr)   # mail chiffré obligatoire
        r = sql("INSERT INTO identity.account_identities (phone_hmac, email_hmac, email_enc) "
                "VALUES ('\\x24', '\\x02', '\\x25')", "argos_identity")
        self.assertIn(DOUBLON, r.stderr)   # même mail que le compte 0a
        for role in ("argos_app", "argos_admin", "argos_scoring", "argos_worker"):
            with self.subTest(role=role):
                self.assertIn(REFUSE, sql("SELECT email_enc FROM identity.account_identities", role).stderr)

    def test_site_public_ne_lit_pas_les_votes(self):
        self.assertIn(REFUSE, sql("SELECT * FROM core.votes", "argos_app").stderr)

    def test_poids_du_vote_calcule_par_la_base(self):
        """Le site tente d'imposer un poids de 10 : la base le remplace par le vrai (novice : 1 x 0,5)."""
        valeur("""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                  VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
                          '00000000-0000-0000-0000-00000000000b', 'review', 'valid', ARRAY['authentic'], '{}', 10)""", "argos_app")
        self.assertEqual(valeur("SELECT weight FROM core.votes "
                                "WHERE summons_id = '00000000-0000-0000-0000-0000000000c1'"), "0.500")

    def test_lien_vote_compte_coupe_apres_six_mois(self):
        valeur("""INSERT INTO core.summons (id, video_id, account_id, round, sent_at, expires_at) VALUES
                  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000f2',
                   '00000000-0000-0000-0000-00000000000a', 'review', now() - interval '7 months',
                   now() + interval '1 day');
                  INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                  VALUES ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000f2',
                          '00000000-0000-0000-0000-00000000000a', 'review', 'invalid', ARRAY['nothing_visible'], '{}', 1);
                  UPDATE core.votes SET cast_at = now() - interval '7 months'
                  WHERE summons_id = '00000000-0000-0000-0000-0000000000c9';""")
        valeur("SELECT core.unlink_old_votes(6)", "argos_scoring")
        self.assertEqual(valeur("SELECT account_id IS NULL FROM core.votes "
                                "WHERE summons_id = '00000000-0000-0000-0000-0000000000c9'"), "t")
        self.assertEqual(valeur("SELECT account_id IS NULL FROM core.summons "
                                "WHERE id = '00000000-0000-0000-0000-0000000000c9'"), "t")
        # Une convocation récente n'est pas touchée.
        self.assertEqual(valeur("SELECT account_id IS NOT NULL FROM core.summons "
                                "WHERE id = '00000000-0000-0000-0000-0000000000c1'"), "t")

    # --- Sessions (0015) -------------------------------------------------------

    def test_session_exige_une_empreinte_de_jeton(self):
        r = sql("INSERT INTO core.sessions (account_id, expires_at) "
                "VALUES ('00000000-0000-0000-0000-00000000000b', now() + interval '1 day')", "argos_app")
        self.assertIn("23502", r.stderr)
        r = sql("INSERT INTO core.sessions (account_id, expires_at, token_hash) "
                "VALUES ('00000000-0000-0000-0000-00000000000b', now() + interval '1 day', '\\x01')", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)

    def test_le_site_cree_une_session_mais_jamais_d_administration(self):
        valeur("INSERT INTO core.sessions (account_id, expires_at, token_hash) "
               "VALUES ('00000000-0000-0000-0000-00000000000b', now() + interval '1 day', sha256('jeton 1'))",
               "argos_app")
        r = sql("INSERT INTO core.sessions (account_id, expires_at, token_hash, is_admin) "
                "VALUES ('00000000-0000-0000-0000-00000000000b', now() + interval '1 day', sha256('jeton 2'), true)",
                "argos_app")
        self.assertIn(REFUSE, r.stderr)
        r = sql("UPDATE core.sessions SET token_hash = sha256('autre')", "argos_app")
        self.assertIn(REFUSE, r.stderr)   # l'empreinte ne se réécrit pas
        # Le site ne lit plus les empreintes (0115) : il retrouve une session par la base, puis la touche par son id.
        self.assertIn(REFUSE, sql("UPDATE core.sessions SET last_seen_at = now() WHERE token_hash = sha256('jeton 1')", "argos_app").stderr)
        sid = valeur("SELECT id FROM core.read_session(sha256('jeton 1'), 7)", "argos_app")
        valeur(f"UPDATE core.sessions SET last_seen_at = now() WHERE id = '{sid}'", "argos_app")

    # --- Codes de secours et mot de passe (0016) ------------------------------

    def test_creation_exige_dix_codes_de_secours(self):
        for n in (0, 9, 11):
            with self.subTest(codes=n):
                self.assertIn("22023", self._creer(f"Codes_{n}", f"\\x8{n % 10}", f"\\x9{n % 10}", codes=n).stderr)

    def test_code_de_secours_bien_forme_et_unique(self):
        compte = "00000000-0000-0000-0000-00000000000b"
        r = sql(f"INSERT INTO core.backup_codes (account_id, code_hash) VALUES ('{compte}', 'K7M2P9XWQR')", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)   # un code en clair n'est pas une empreinte
        valeur(f"INSERT INTO core.backup_codes (account_id, code_hash) VALUES ('{compte}', repeat('ab', 32))", "argos_app")
        r = sql(f"INSERT INTO core.backup_codes (account_id, code_hash) VALUES ('{compte}', repeat('ab', 32))", "argos_app")
        self.assertIn(DOUBLON, r.stderr)

    def test_code_de_secours_utilise_ne_redevient_pas_valable(self):
        compte = "00000000-0000-0000-0000-00000000000b"
        valeur(f"INSERT INTO core.backup_codes (account_id, code_hash) VALUES ('{compte}', repeat('cd', 32))", "argos_app")
        valeur("UPDATE core.backup_codes SET used_at = now() WHERE code_hash = repeat('cd', 32)", "argos_app")
        r = sql("UPDATE core.backup_codes SET used_at = NULL WHERE code_hash = repeat('cd', 32)", "argos_app")
        self.assertIn("redevenir valable", r.stderr)
        r = sql("UPDATE core.backup_codes SET code_hash = repeat('ef', 32) WHERE code_hash = repeat('cd', 32)", "argos_app")
        self.assertIn(REFUSE, r.stderr)
        r = sql(f"UPDATE core.backup_codes SET account_id = '00000000-0000-0000-0000-00000000000a' "
                "WHERE code_hash = repeat('cd', 32)", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_le_site_change_un_mot_de_passe_mais_pas_son_compte(self):
        r = sql("UPDATE core.credentials SET account_id = '00000000-0000-0000-0000-00000000000b'", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    # --- Double authentification et appareils (0017) --------------------------

    def test_une_seule_application_totp_active_par_compte(self):
        compte = "00000000-0000-0000-0000-00000000000b"
        valeur(f"INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('{compte}', 'totp', '\\x01')",
               "argos_app")
        r = sql(f"INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('{compte}', 'totp', '\\x02')",
                "argos_app")
        self.assertIn(DOUBLON, r.stderr)
        # Après retrait, une nouvelle peut être ajoutée ; l'ancienne ne se réactive pas.
        valeur(f"UPDATE core.mfa_factors SET revoked_at = now() WHERE account_id = '{compte}' AND kind = 'totp'", "argos_app")
        valeur(f"INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('{compte}', 'totp', '\\x02')",
               "argos_app")
        r = sql(f"UPDATE core.mfa_factors SET revoked_at = NULL WHERE account_id = '{compte}' AND revoked_at IS NOT NULL",
                "argos_app")
        self.assertIn("réactivée", r.stderr)

    def test_le_site_ne_modifie_pas_une_methode_existante(self):
        for col in ("totp_secret_enc = '\\x99'", "kind = 'webauthn'", "account_id = '00000000-0000-0000-0000-00000000000a'",
                    "public_key = '\\x99'", "label = 'x'"):
            with self.subTest(col=col):
                self.assertIn(REFUSE, sql(f"UPDATE core.mfa_factors SET {col}", "argos_app").stderr)

    def test_appareils_connus_empreinte_seulement(self):
        compte = "00000000-0000-0000-0000-00000000000b"
        r = sql(f"INSERT INTO core.known_devices (account_id, device_hash) VALUES ('{compte}', '\\x01')", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)
        valeur(f"INSERT INTO core.known_devices (account_id, device_hash) VALUES ('{compte}', sha256('appareil'))", "argos_app")
        self.assertIn(REFUSE, sql("UPDATE core.known_devices SET device_hash = sha256('autre')", "argos_app").stderr)
        for role in ("argos_admin", "argos_scoring", "argos_worker", "argos_identity"):
            with self.subTest(role=role):
                self.assertIn(REFUSE, sql("SELECT * FROM core.known_devices", role).stderr)

    def test_cle_de_securite_transports_connus_seulement(self):
        compte = "00000000-0000-0000-0000-00000000000b"
        valeur(f"INSERT INTO core.mfa_factors (account_id, kind, credential_id, public_key, sign_count, transports) "
               f"VALUES ('{compte}', 'webauthn', '\\xa1', '\\xa2', 0, ARRAY['usb', 'nfc'])", "argos_app")
        r = sql(f"INSERT INTO core.mfa_factors (account_id, kind, credential_id, public_key, transports) "
                f"VALUES ('{compte}', 'webauthn', '\\xb1', '\\xb2', ARRAY['<script>'])", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)
        r = sql(f"INSERT INTO core.mfa_factors (account_id, kind, credential_id, public_key) "
                f"VALUES ('{compte}', 'webauthn', '\\xa1', '\\xc2')", "argos_app")
        self.assertIn(DOUBLON, r.stderr)   # une même clé ne s'enregistre qu'une fois

    # --- Envois (0019) ----------------------------------------------------------

    def _envoi(self, vid, expire="now() + interval '1 day'"):
        valeur(f"INSERT INTO core.videos (id, upload_expires_at, metadata_check) "
               f"VALUES ('{vid}', {expire}, 'absent')", "argos_app")

    def test_un_envoi_commence_toujours_en_cours(self):
        self._envoi("00000000-0000-0000-0000-000000000e01")
        self.assertEqual(valeur("SELECT status FROM core.videos WHERE id = '00000000-0000-0000-0000-000000000e01'"), "uploading")
        r = sql("INSERT INTO core.videos (status, upload_expires_at) VALUES ('in_review', now())", "argos_app")
        self.assertIn(REFUSE, r.stderr)   # le site ne choisit pas le statut
        r = sql("INSERT INTO core.videos (id) VALUES ('00000000-0000-0000-0000-000000000e02')", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)   # un envoi en cours a toujours une échéance

    def test_finalisation_seule_transition_du_site_pour_un_envoi(self):
        vid = "00000000-0000-0000-0000-000000000e03"
        self._envoi(vid)
        for interdit in ("in_review", "published", "awaiting_author"):
            with self.subTest(statut=interdit):
                self.assertIn("transition de statut interdite",
                              sql(f"UPDATE core.videos SET status = '{interdit}' WHERE id = '{vid}'", "argos_app").stderr)
        valeur(f"UPDATE core.videos SET status = 'processing', upload_expires_at = NULL WHERE id = '{vid}'", "argos_app")
        self.assertIn("transition de statut interdite",
                      sql(f"UPDATE core.videos SET status = 'uploading' WHERE id = '{vid}'", "argos_app").stderr)

    def test_le_site_n_efface_qu_un_envoi_en_cours(self):
        en_cours, finalise = "00000000-0000-0000-0000-000000000e04", "00000000-0000-0000-0000-000000000e05"
        self._envoi(en_cours)
        self._envoi(finalise)
        valeur(f"UPDATE core.videos SET status = 'processing', upload_expires_at = NULL WHERE id = '{finalise}'", "argos_app")
        self.assertIn(REFUSE, sql(f"DELETE FROM core.videos WHERE id = '{en_cours}'", "argos_app").stderr)
        self.assertEqual(valeur(f"SELECT core.abandon_upload('{finalise}')", "argos_app"), "f")
        self.assertEqual(valeur(f"SELECT core.abandon_upload('{en_cours}')", "argos_app"), "t")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.videos WHERE id IN ('{en_cours}', '{finalise}')"), "1")

    def test_purge_des_envois_expires_seulement(self):
        expire, valable = "00000000-0000-0000-0000-000000000e06", "00000000-0000-0000-0000-000000000e07"
        self._envoi(expire, "now() - interval '1 minute'")
        self._envoi(valable)
        purges = valeur("SELECT string_agg(id::text, ',') FROM core.purge_expired_uploads() AS id", "argos_app")
        self.assertIn(expire, purges)
        self.assertNotIn(valable, purges)
        self.assertEqual(valeur(f"SELECT count(*) FROM core.videos WHERE id = '{valable}'"), "1")

    def test_description_limitee(self):
        r = sql("INSERT INTO core.videos (upload_expires_at, description) VALUES (now(), repeat('a', 5001))", "argos_app")
        self.assertIn(CONTRAINTE, r.stderr)

    # --- Retrait par la source (0020) ----------------------------------------------

    def _video_a_retirer(self, vid, code, statut="in_review"):
        valeur(f"""INSERT INTO core.videos (id, status, description, location, location_precision, r2_original_enc_key,
                                         upload_expires_at)
                   VALUES ('{vid}', '{statut}', 'Description', ST_GeogFromText('POINT(2.35 48.85)'), 'exact',
                           'originaux/{vid}', CASE WHEN '{statut}' = 'uploading' THEN now() + interval '1 day' END);
                   INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash, contact_allowed)
                   VALUES ('{vid}', 'Retrait-{vid[-4:]}', sha256('{code}'), true)""")

    def test_retrait_par_la_source(self):
        vid = "00000000-0000-0000-0000-000000000d01"
        self._video_a_retirer(vid, "retrait d01")
        pseudo = valeur(f"SELECT id FROM core.pseudonyms WHERE video_id = '{vid}'")
        self._cles_messagerie(pseudo, '00000000-0000-0000-0000-00000000000a')
        valeur(f"""INSERT INTO core.verifications (account_id, category, expires_at)
                   VALUES ('00000000-0000-0000-0000-00000000000a', 'journalist', now() + interval '1 year');
                   INSERT INTO core.conversations (pseudonym_id, verified_account_id)
                   VALUES ('{pseudo}', '00000000-0000-0000-0000-00000000000a');
                   INSERT INTO core.summons (video_id, account_id, round, expires_at)
                   VALUES ('{vid}', '00000000-0000-0000-0000-00000000000b', 'review', now() + interval '2 days')""")
        r = valeur("SELECT core.withdraw_video(sha256('retrait d01'))", "argos_app")
        self.assertIn('"resultat": "ok"', r)
        self.assertIn(f'"original": "originaux/{vid}"', r)
        self.assertEqual(valeur(f"""SELECT status || ' ' || (withdrawn_at IS NOT NULL) || ' ' || coalesce(description, '-')
                                    || ' ' || coalesce(location::text, '-') || ' ' || coalesce(r2_original_enc_key, '-')
                                    FROM core.videos WHERE id = '{vid}'"""), "withdrawn true - - -")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.conversations WHERE pseudonym_id = '{pseudo}' AND closed_at IS NULL"), "0")
        self.assertEqual(valeur(f"SELECT outcome FROM core.summons WHERE video_id = '{vid}'"), "cancelled")
        self.assertEqual(valeur(f"SELECT count(*) FROM ledger.entries WHERE kind = 'withdrawal' AND payload->>'video' = '{vid}'"), "1")
        # B2 (0104) : le code ne désigne plus la vidéo retirée ; heure du retrait au jour seulement.
        self.assertIn("introuvable", valeur("SELECT core.withdraw_video(sha256('retrait d01'))", "argos_app"))
        self.assertEqual(valeur(f"SELECT withdrawn_at = date_trunc('day', withdrawn_at) FROM core.videos WHERE id = '{vid}'"), "t")

    def test_retrait_cas_particuliers(self):
        self.assertIn("introuvable", valeur("SELECT core.withdraw_video(sha256('aucune'))", "argos_app"))
        self._video_a_retirer("00000000-0000-0000-0000-000000000d02", "retrait d02", "uploading")
        self.assertIn("envoi_en_cours", valeur("SELECT core.withdraw_video(sha256('retrait d02'))", "argos_app"))
        self._video_a_retirer("00000000-0000-0000-0000-000000000d03", "retrait d03", "published")
        valeur("UPDATE core.videos SET legal_hold = true WHERE id = '00000000-0000-0000-0000-000000000d03'", "argos_admin")
        self.assertIn("bloque", valeur("SELECT core.withdraw_video(sha256('retrait d03'))", "argos_app"))
        self.assertEqual(valeur("SELECT status FROM core.videos WHERE id = '00000000-0000-0000-0000-000000000d03'"), "published")

    def test_le_site_ne_retire_ni_ne_bloque_directement(self):
        self._video_a_retirer("00000000-0000-0000-0000-000000000d04", "retrait d04")
        r = sql("UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() "
                "WHERE id = '00000000-0000-0000-0000-000000000d04'", "argos_app")
        self.assertIn(REFUSE, r.stderr)   # withdrawn_at n'est pas modifiable : seule la fonction retire
        self.assertIn(REFUSE, sql("UPDATE core.videos SET legal_hold = false", "argos_app").stderr)

    # --- Traitement par le worker (0021) ----------------------------------------

    def test_worker_termine_ou_refuse_une_video_en_traitement(self):
        ok, ko = "00000000-0000-0000-0000-000000000c61", "00000000-0000-0000-0000-000000000c62"
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{ok}', 'processing'), ('{ko}', 'processing')")
        valeur(f"UPDATE core.videos SET processing_started_at = now(), processing_progress = 50 WHERE id = '{ok}'", "argos_worker")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author', r2_blurred_key = 'floutees/{ok}' WHERE id = '{ok}'", "argos_worker")
        r = sql(f"UPDATE core.videos SET status = 'failed' WHERE id = '{ko}'", "argos_worker")
        self.assertIn(CONTRAINTE, r.stderr)   # un échec a toujours une raison
        valeur(f"UPDATE core.videos SET status = 'failed', failure_reason = 'not_a_video' WHERE id = '{ko}'", "argos_worker")
        for statut in ("in_review", "published"):
            with self.subTest(statut=statut):
                self.assertIn("transition de statut interdite",
                              sql(f"UPDATE core.videos SET status = '{statut}' WHERE id = '{ok}'", "argos_worker").stderr)

    def test_worker_ne_voit_pas_le_contexte(self):
        for col in ("description", "location", "occurred_at", "forces"):
            with self.subTest(col=col):
                self.assertIn(REFUSE, sql(f"SELECT {col} FROM core.videos", "argos_worker").stderr)
        self.assertIn(REFUSE, sql("SELECT * FROM core.pseudonyms", "argos_worker").stderr)

    # --- Vérification par la source (0023) ---------------------------------------

    def test_attente_de_verification_datee_par_la_base(self):
        vid = "00000000-0000-0000-0000-000000000c71"
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'processing')")
        self.assertEqual(valeur(f"SELECT awaiting_since IS NULL FROM core.videos WHERE id = '{vid}'"), "t")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author', r2_blurred_key = 'f' WHERE id = '{vid}'", "argos_worker")
        self.assertEqual(valeur(f"SELECT now() - awaiting_since < interval '1 day' AND awaiting_since = date_trunc('day', awaiting_since, 'Europe/Paris') FROM core.videos WHERE id = '{vid}'"), "t")
        self.assertIn(REFUSE, sql(f"UPDATE core.videos SET awaiting_since = now() - interval '30 days' WHERE id = '{vid}'",
                                  "argos_app").stderr)   # le site ne peut pas avancer l'échéance
        valeur(f"UPDATE core.videos SET status = 'in_review' WHERE id = '{vid}'", "argos_app")

    def test_retouches_limitees(self):
        vid = "00000000-0000-0000-0000-000000000c72"
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'awaiting_author')")
        r = sql(f"UPDATE core.videos SET retouches = 11 WHERE id = '{vid}'", "argos_app")
        self.assertIn("ERREUR", r.stderr)
        self.assertEqual(valeur(f"SELECT retouches FROM core.videos WHERE id = '{vid}'"), "0")

    # --- Retouches (0024) -------------------------------------------------------

    def test_retouche_compte_une_de_plus_et_dix_au_plus(self):
        vid = "00000000-0000-0000-0000-000000000c73"
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'awaiting_author')")
        # Sans compter la retouche, ou en en comptant deux : refusé.
        for n in (0, 2):
            with self.subTest(n=n):
                self.assertIn("ERREUR", sql(f"UPDATE core.videos SET status = 'processing', retouches = {n} WHERE id = '{vid}'",
                                            "argos_app").stderr)
        # Le compteur ne bouge pas seul (ni à la hausse ni à la baisse).
        self.assertIn("ERREUR", sql(f"UPDATE core.videos SET retouches = 1 WHERE id = '{vid}'", "argos_app").stderr)
        valeur(f"UPDATE core.videos SET status = 'processing', retouches = 1, processing_attempts = 0 WHERE id = '{vid}'", "argos_app")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author' WHERE id = '{vid}'", "argos_worker")
        self.assertIn("ERREUR", sql(f"UPDATE core.videos SET retouches = 0 WHERE id = '{vid}'", "argos_app").stderr)
        valeur(f"UPDATE core.videos SET retouches = 10 WHERE id = '{vid}'")   # propriétaire : 10 retouches faites
        self.assertIn("ERREUR", sql(f"UPDATE core.videos SET status = 'processing', retouches = 11 WHERE id = '{vid}'",
                                    "argos_app").stderr)
        self.assertEqual(valeur(f"SELECT status FROM core.videos WHERE id = '{vid}'"), "awaiting_author")

    def test_echeance_sept_jours_au_total_et_24_h_apres_une_retouche(self):
        vid = "00000000-0000-0000-0000-000000000c74"
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'processing')")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author' WHERE id = '{vid}'", "argos_worker")
        self.assertEqual(valeur(f"SELECT review_deadline - awaiting_since BETWEEN interval '7 days' AND interval '9 days' FROM core.videos WHERE id = '{vid}'"), "t")
        # Une retouche tôt : l'échéance ne repart pas de zéro.
        valeur(f"UPDATE core.videos SET awaiting_since = now() - interval '1 day' WHERE id = '{vid}'")
        valeur(f"UPDATE core.videos SET status = 'processing', retouches = 1 WHERE id = '{vid}'", "argos_app")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author' WHERE id = '{vid}'", "argos_worker")
        self.assertEqual(valeur(f"""SELECT now() - awaiting_since > interval '23 hours'
                                          AND extract(epoch FROM review_deadline - (now() + interval '6 days')) BETWEEN -60 AND 86400   -- arrondie au jour suivant (0117)
                                     FROM core.videos WHERE id = '{vid}'"""), "t")
        # Une retouche tardive : au moins 24 h pour vérifier le résultat.
        valeur(f"UPDATE core.videos SET awaiting_since = now() - interval '6 days 23 hours' WHERE id = '{vid}'")
        valeur(f"UPDATE core.videos SET status = 'processing', retouches = 2 WHERE id = '{vid}'", "argos_app")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author' WHERE id = '{vid}'", "argos_worker")
        self.assertEqual(valeur(f"""SELECT extract(epoch FROM review_deadline - (now() + interval '24 hours')) BETWEEN -60 AND 86400
                                     FROM core.videos WHERE id = '{vid}'"""), "t")
        self.assertIn(REFUSE, sql(f"UPDATE core.videos SET review_deadline = now() + interval '1 year' WHERE id = '{vid}'",
                                  "argos_app").stderr)

    # --- Convocations (0025) ---------------------------------------------------------

    def test_tirage_des_convocations(self):
        vid = "00000000-0000-0000-7a00-000000000001"
        valeur(f"""
            INSERT INTO core.videos (id, status) VALUES ('{vid}', 'in_review');
            INSERT INTO core.accounts (id, username)
                SELECT ('00000000-0000-0000-0000-0000000e' || lpad(g::text, 4, '0'))::uuid, 'Tirage_' || g
                  FROM generate_series(1, 60) g;
            INSERT INTO core.accounts (id, username, status) VALUES
                ('00000000-0000-0000-0000-0000000f0001', 'Tirage_Banni', 'banned');""")
        # Un compte qui a déjà fait ses 5 relectures des dernières 24 h.
        plein = "00000000-0000-0000-0000-0000000f0002"
        valeur(f"INSERT INTO core.accounts (id, username) VALUES ('{plein}', 'Tirage_Plein')")
        for i in range(5):
            autre = f"00000000-0000-0000-7a01-0000000000{i:02d}"
            valeur(f"""INSERT INTO core.videos (id, status) VALUES ('{autre}', 'in_review');
                       INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                            VALUES ('00000000-0000-0000-7a02-0000000000{i:02d}', '{autre}', '{plein}', 'review', now() + interval '1 day');
                       INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                            VALUES ('00000000-0000-0000-7a02-0000000000{i:02d}', '{autre}', '{plein}', 'review', 'valid', ARRAY['authentic'], '{{}}', 0);
                       UPDATE core.videos SET status = 'jury' WHERE id = '{autre}';""")
        self.assertIn(REFUSE, sql("SELECT core.draw_summons()", "argos_app").stderr)
        # Le tirage touche toutes les vidéos en relecture : on retire ensuite les convocations tirées
        # pour les vidéos des autres tests.
        avant = valeur("SELECT coalesce(max(sent_at), '-infinity') FROM core.summons")
        self.addCleanup(valeur, f"DELETE FROM core.summons WHERE video_id <> '{vid}' AND sent_at > '{avant}'")
        compte = lambda cond="true": int(valeur(f"SELECT count(*) FROM core.summons WHERE video_id = '{vid}' AND {cond}"))
        valeur("SELECT core.draw_summons()", "argos_scoring")
        self.assertEqual(compte(), 45)   # 15 places × 3
        self.assertEqual(compte("outcome = 'pending' AND expires_at BETWEEN now() + interval '47 hours' AND now() + interval '49 hours'"), 45)
        valeur("SELECT core.draw_summons()", "argos_scoring")
        self.assertEqual(compte(), 45)   # rien de plus tant que les convocations courent
        # Expiration : de nouveaux comptes sont tirés, jamais deux fois le même, jusqu'à épuisement.
        for _ in range(10):
            valeur(f"UPDATE core.summons SET sent_at = now() - interval '3 days', expires_at = now() WHERE video_id = '{vid}' AND outcome = 'pending'")
            valeur("SELECT core.draw_summons()", "argos_scoring")
        self.assertEqual(compte("outcome = 'expired'") + compte("outcome = 'pending'"), compte())
        self.assertEqual(int(valeur(f"SELECT count(DISTINCT account_id) FROM core.summons WHERE video_id = '{vid}'")), compte())
        tires = valeur(f"SELECT string_agg(a.username, ',') FROM core.summons s JOIN core.accounts a ON a.id = s.account_id WHERE s.video_id = '{vid}'").split(",")
        self.assertTrue(all(f"Tirage_{g}" in tires for g in range(1, 61)))   # tous les comptes actifs, à force
        self.assertNotIn("Tirage_Banni", tires)
        self.assertNotIn("Tirage_Plein", tires)

    def test_convocation_le_site_ne_peut_que_passer(self):
        vid = "00000000-0000-0000-7a00-000000000002"
        b = "00000000-0000-0000-0000-00000000000b"
        valeur(f"""INSERT INTO core.videos (id, status) VALUES ('{vid}', 'in_review');
                   INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES
                     ('00000000-0000-0000-7a03-000000000021', '{vid}', '{b}', 'review', now() + interval '1 day'),
                     ('00000000-0000-0000-7a03-000000000022', '{vid}', '{b}', 'jury', now() + interval '1 day')""")
        un, deux = "00000000-0000-0000-7a03-000000000021", "00000000-0000-0000-7a03-000000000022"
        for issue in ("voted", "expired", "cancelled"):
            with self.subTest(issue=issue):
                self.assertIn("ERREUR", sql(f"UPDATE core.summons SET outcome = '{issue}', answered_at = now() WHERE id = '{un}'",
                                            "argos_app").stderr)
        self.assertIn("ERREUR", sql(f"UPDATE core.summons SET outcome = 'passed' WHERE id = '{un}'", "argos_app").stderr)  # sans date
        valeur(f"UPDATE core.summons SET outcome = 'passed', answered_at = now() WHERE id = '{un}'", "argos_app")
        self.assertIn("ERREUR", sql(f"UPDATE core.summons SET outcome = 'pending', answered_at = NULL WHERE id = '{un}'",
                                    "argos_app").stderr)
        valeur(f"UPDATE core.summons SET sent_at = now() - interval '3 days', expires_at = now() - interval '1 second' WHERE id = '{deux}'")
        self.assertIn("ERREUR", sql(f"UPDATE core.summons SET outcome = 'passed', answered_at = now() WHERE id = '{deux}'",
                                    "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"UPDATE core.summons SET expires_at = now() + interval '9 days' WHERE id = '{deux}'",
                                  "argos_app").stderr)

    # --- Création atomique d'un relecteur (identity.create_reviewer) ---------

    @staticmethod
    def _creer(pseudo, tel, mail, role="argos_identity", empreinte="$argon2id$v=19$m=19456,t=2,p=1$c2Vs$aGFjaGU",
               codes=10):
        # Empreintes de codes de secours factices, propres au pseudo (uniques).
        tableau = (f"ARRAY(SELECT encode(sha256(('{pseudo}' || g)::bytea), 'hex') "
                   f"FROM generate_series(1, {codes}) g)")
        return sql(f"SELECT identity.create_reviewer('{pseudo}', '{empreinte}', '{tel}', '{mail}', "
                   f"'\\xee', {tableau}, '192.0.2.10', 51234)", role)

    def test_creation_d_un_relecteur(self):
        r = self._creer("Nouveau_1", "\\x31", "\\x32")
        self.assertEqual(r.returncode, 0, r.stderr)
        compte = r.stdout.strip()
        self.assertEqual(valeur(f"SELECT username FROM core.accounts WHERE id = '{compte}'"), "Nouveau_1")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.credentials WHERE account_id = '{compte}'"), "1")
        self.assertEqual(valeur(f"SELECT count(*) FROM identity.account_identities WHERE account_id = '{compte}' "
                                "AND email_verified_at IS NOT NULL"), "1")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.backup_codes WHERE account_id = '{compte}' "
                                "AND used_at IS NULL AND invalidated_at IS NULL"), "10")
        self.assertEqual(valeur(f"SELECT action || ' ' || host(ip) || ' ' || source_port "
                                f"FROM identity.legal_connection_logs WHERE account_id = '{compte}'"),
                         "signup 192.0.2.10 51234")

    def test_creation_tout_ou_rien(self):
        """Pseudo déjà pris : rien n'est créé, ni identité ni journal."""
        avant = valeur("SELECT count(*) FROM identity.account_identities")
        r = self._creer("ADMIN", "\\x41", "\\x42")   # « Admin » existe déjà
        self.assertIn(DOUBLON, r.stderr)
        self.assertEqual(valeur("SELECT count(*) FROM identity.account_identities"), avant)
        self.assertEqual(valeur("SELECT count(*) FROM identity.account_identities WHERE phone_hmac = '\\x41'"), "0")

    def test_creation_refusee_pour_un_numero_ou_un_mail_banni(self):
        self.assertIn(REFUSE, self._creer("Revenant_1", "\\x0d", "\\x51").stderr)   # numéro banni
        self.assertIn(REFUSE, self._creer("Revenant_2", "\\x52", "\\x0e").stderr)   # mail banni

    def test_creation_exige_une_empreinte_argon2id(self):
        r = self._creer("EnClair", "\\x61", "\\x62", empreinte="motdepasse")
        self.assertIn("22023", r.stderr)

    def test_seul_le_role_d_inscription_cree_un_relecteur(self):
        for role in ("argos_app", "argos_admin", "argos_scoring", "argos_worker"):
            with self.subTest(role=role):
                self.assertIn(REFUSE, self._creer("Intrus_" + role[6:], "\\x71", "\\x72", role=role).stderr)

    # --- Comptes et vidéos : ce que le site public ne peut pas faire -----------

    def test_site_public_ne_modifie_pas_le_score_ni_le_super_admin(self):
        for requete in ("UPDATE core.accounts SET score = 10",
                        "UPDATE core.accounts SET is_superadmin = true"):
            with self.subTest(requete=requete):
                self.assertIn(REFUSE, sql(requete, "argos_app").stderr)

    def test_site_public_ne_peut_pas_publier(self):
        r = sql("UPDATE core.videos SET status = 'published' "
                "WHERE id = '00000000-0000-0000-0000-0000000000f1'", "argos_app")
        self.assertIn("transition de statut interdite", r.stderr)

    def test_seul_le_calcul_des_decisions_publie(self):
        valeur("UPDATE core.videos SET status = 'published' "
               "WHERE id = '00000000-0000-0000-0000-0000000000f2'", "argos_scoring")
        self.assertEqual(valeur("SELECT status FROM core.videos "
                                "WHERE id = '00000000-0000-0000-0000-0000000000f2'"), "published")

    def test_admin_masque_mais_ne_publie_pas(self):
        valeur("INSERT INTO core.videos (id, status) VALUES ('00000000-0000-0000-0000-0000000000f3', 'in_review')")
        r = sql("UPDATE core.videos SET status = 'published' "
                "WHERE id = '00000000-0000-0000-0000-0000000000f3'", "argos_admin")
        self.assertIn("transition de statut interdite", r.stderr)
        valeur("UPDATE core.videos SET status = 'hidden' "
               "WHERE id = '00000000-0000-0000-0000-0000000000f3'", "argos_admin")

    def test_site_public_cree_une_video_seulement_en_cours_d_envoi(self):
        r = sql("INSERT INTO core.videos (id, upload_expires_at) VALUES ('00000000-0000-0000-0000-0000000000f4', "
                "now() + interval '1 day')", "argos_app")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(REFUSE,
                      sql("INSERT INTO core.videos (id, is_control, control_truth) "
                          "VALUES (gen_random_uuid(), true, true)", "argos_app").stderr)

    def test_site_public_ne_voit_pas_la_reponse_des_controles(self):
        self.assertIn(REFUSE, sql("SELECT control_truth FROM core.videos", "argos_app").stderr)

    def test_le_worker_ne_voit_aucun_compte(self):
        self.assertIn(REFUSE, sql("SELECT * FROM core.accounts", "argos_worker").stderr)
        self.assertIn(REFUSE, sql("SELECT description FROM core.videos", "argos_worker").stderr)

    def test_video_de_controle_jamais_publiee(self):
        r = sql("INSERT INTO core.videos (is_control, control_truth, status) VALUES (true, true, 'published')")
        self.assertIn(CONTRAINTE, r.stderr)

    def test_droit_admin_inconnu_refuse(self):
        r = sql("""INSERT INTO core.admin_rights (account_id, right_code, granted_by) VALUES
                   ('00000000-0000-0000-0000-00000000000b', 'admins.manage',
                    '00000000-0000-0000-0000-00000000000a')""", "argos_admin")
        self.assertIn(CONTRAINTE, r.stderr)   # admins.manage n'est pas délégable

    # --- Géolocalisation : suggestion d'événement -----------------------------

    def test_videos_proches_trouvees_pour_un_evenement(self):
        n = valeur("""SELECT count(*) FROM core.videos v
                      WHERE v.id <> '00000000-0000-0000-0000-0000000000f1'
                        AND ST_DWithin(v.location,
                            (SELECT location FROM core.videos WHERE id = '00000000-0000-0000-0000-0000000000f1'),
                            500)""", "argos_app")
        self.assertEqual(n, "1")   # la vidéo f2, à une centaine de mètres

    # --- Journal public infalsifiable -----------------------------------------

    def test_journal_chaine_et_verifiable(self):
        for i in range(3):
            valeur(f"SELECT ledger.append('decision', '{{\"n\": {i}}}')")
        self.assertEqual(valeur("SELECT ledger.verify() IS NULL", "argos_app"), "t")

    def test_journal_en_ajout_seul(self):
        valeur("SELECT ledger.append('rule_change', '{\"v\": 2}')")
        # Revue de sécurité (A2, 0098) : aucun rôle applicatif n'écrit directement au journal.
        for role in ("argos_app", "argos_admin", "argos_scoring", "argos_worker"):
            with self.subTest(role=role):
                self.assertIn(REFUSE, sql("SELECT ledger.append('decision', '{\"faux\": true}')", role).stderr)
        for requete in ("UPDATE ledger.entries SET payload = '{}'", "DELETE FROM ledger.entries",
                        "TRUNCATE ledger.entries"):
            with self.subTest(requete=requete):
                self.assertNotEqual(sql(requete).returncode, 0)   # même le propriétaire est refusé
        self.assertIn(REFUSE,
                      sql("INSERT INTO ledger.entries (kind, payload, prev_hash, hash) "
                          "VALUES ('decision', '{}', '\\x00', '\\x01')", "argos_app").stderr)

    def test_journal_detecte_une_falsification(self):
        """Simule une modification directe en contournant le garde-fou : la vérification la repère."""
        valeur("SELECT ledger.append('rule_change', '{\"motif\": \"illegal_content\"}')")
        valeur("""ALTER TABLE ledger.entries DISABLE TRIGGER entries_append_only;
                  UPDATE ledger.entries SET payload = '{"motif": "falsifie"}'
                  WHERE seq = (SELECT max(seq) FROM ledger.entries);
                  ALTER TABLE ledger.entries ENABLE TRIGGER entries_append_only;""")
        self.assertNotEqual(valeur("SELECT ledger.verify()"), "")   # un numéro de ligne, pas NULL


    # --- Durcissement (0011) ---------------------------------------------------

    def test_site_public_ne_cree_pas_de_session_admin(self):
        r = sql("INSERT INTO core.sessions (account_id, expires_at, is_admin) VALUES "
                "('00000000-0000-0000-0000-00000000000b', now() + interval '1 hour', true)", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_session_revoquee_non_reactivable(self):
        valeur("""INSERT INTO core.sessions (id, account_id, expires_at, revoked_at, token_hash) VALUES
                  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000b',
                   now() + interval '1 hour', now(), sha256('jeton e1'))""")
        r = sql("UPDATE core.sessions SET revoked_at = NULL "
                "WHERE id = '00000000-0000-0000-0000-0000000000e1'", "argos_app")
        self.assertIn("réactivée", r.stderr)

    def test_vote_a_la_place_d_un_autre_refuse(self):
        valeur("""INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES
                  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1',
                   '00000000-0000-0000-0000-00000000000a', 'review', now() + interval '2 days')""")
        r = sql("""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                   VALUES ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1',
                           '00000000-0000-0000-0000-00000000000b', 'review', 'valid', ARRAY['authentic'], '{}', 1)""", "argos_app")
        self.assertIn("argos:sans_convocation", r.stderr)

    def test_vote_sur_convocation_expiree_ou_deja_utilisee_refuse(self):
        valeur("""INSERT INTO core.summons (id, video_id, account_id, round, sent_at, expires_at) VALUES
                  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f2',
                   '00000000-0000-0000-0000-00000000000b', 'review', now() - interval '3 days',
                   now() - interval '1 day')""")
        r = sql("""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                   VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f2',
                           '00000000-0000-0000-0000-00000000000b', 'review', 'valid', ARRAY['authentic'], '{}', 1)""", "argos_app")
        self.assertIn("argos:convocation_terminee", r.stderr)

    def test_compte_suspendu_ne_vote_pas(self):
        valeur("""INSERT INTO core.accounts (id, username, status, suspended_until) VALUES
                  ('00000000-0000-0000-0000-0000000000a5', 'Suspendu', 'suspended', now() + interval '1 day');
                  INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES
                  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000f1',
                   '00000000-0000-0000-0000-0000000000a5', 'review', now() + interval '2 days')""")
        r = sql("""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                   VALUES ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000f1',
                           '00000000-0000-0000-0000-0000000000a5', 'review', 'valid', ARRAY['authentic'], '{}', 1)""", "argos_app")
        self.assertIn("argos:compte_inactif", r.stderr)

    def test_site_public_ne_valide_pas_un_lien_d_evenement(self):
        valeur("INSERT INTO core.events (id) VALUES ('00000000-0000-0000-0000-0000000000b1')")
        r = sql("""INSERT INTO core.event_links (event_id, video_id, status) VALUES
                   ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1',
                    'validated')""", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_site_public_ne_traite_pas_un_signalement(self):
        r = sql("""INSERT INTO core.reports (video_id, severity, reason_code, status) VALUES
                   ('00000000-0000-0000-0000-0000000000f1', 'normal', 'other', 'handled')""", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    @staticmethod
    def _cles_messagerie(pseudo, compte):
        """Clés de messagerie factices (0055) : une conversation exige celles de la source et du compte."""
        valeur(f"""INSERT INTO core.public_keys (pseudonym_id, public_key, wrapped_private)
                   SELECT '{pseudo}', decode('04' || repeat('11', 64), 'hex'), decode(repeat('22', 40), 'hex')
                   WHERE NOT EXISTS (SELECT 1 FROM core.public_keys WHERE pseudonym_id = '{pseudo}');
                   INSERT INTO core.public_keys (account_id, public_key, wrapped_private, kdf_salt, kdf_iterations)
                   SELECT '{compte}', decode('04' || repeat('33', 64), 'hex'), decode(repeat('44', 40), 'hex'),
                          decode(repeat('55', 16), 'hex'), 600000
                   WHERE NOT EXISTS (SELECT 1 FROM core.public_keys WHERE account_id = '{compte}')""")

    def test_contact_seulement_si_accepte_et_verifie(self):
        pseudo = valeur("SELECT id FROM core.pseudonyms WHERE pseudonym = 'Heron-Ambre-4821'")
        self._cles_messagerie(pseudo, '00000000-0000-0000-0000-00000000000b')
        inserer = (f"INSERT INTO core.conversations (pseudonym_id, verified_account_id) "
                   f"VALUES ('{pseudo}', '00000000-0000-0000-0000-00000000000b')")
        self.assertIn("argos:contact_refuse", sql(inserer, "argos_app").stderr)
        valeur(f"UPDATE core.pseudonyms SET contact_allowed = true WHERE id = '{pseudo}'", "argos_app")
        self.assertIn("argos:compte_non_verifie", sql(inserer, "argos_app").stderr)
        valeur("""INSERT INTO core.verifications (account_id, category, expires_at) VALUES
                  ('00000000-0000-0000-0000-00000000000b', 'journalist', now() + interval '1 year')""")
        self.assertEqual(sql(inserer, "argos_app").returncode, 0)

    def test_sanction_inscrite_automatiquement_au_journal(self):
        avant = int(valeur("SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action'"))
        valeur("""INSERT INTO core.sanctions (account_id, kind, reason_code, issued_by) VALUES
                  ('00000000-0000-0000-0000-00000000000b', 'logout', 'spam',
                   '00000000-0000-0000-0000-00000000000a')""", "argos_admin")
        self.assertEqual(int(valeur("SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action'")), avant + 1)
        dernier = valeur("SELECT payload::text FROM ledger.entries ORDER BY seq DESC LIMIT 1")
        self.assertNotIn("00000000-0000-0000-0000-00000000000b", dernier)   # aucune identité dans le journal

    def test_publication_inscrite_automatiquement_au_journal(self):
        valeur("INSERT INTO core.videos (id, status) VALUES ('00000000-0000-0000-0000-0000000000f5', 'in_review')")
        valeur("UPDATE core.videos SET status = 'published' "
               "WHERE id = '00000000-0000-0000-0000-0000000000f5'", "argos_scoring")
        self.assertEqual(valeur("SELECT count(*) FROM ledger.entries "
                                "WHERE payload->>'video' = '00000000-0000-0000-0000-0000000000f5'"), "1")

    def test_regles_modifiables_seulement_par_le_super_admin(self):
        r = sql("INSERT INTO core.settings (params, changed_by) VALUES "
                "('{}', '00000000-0000-0000-0000-00000000000b')", "argos_admin")
        self.assertIn("super-administrateur", r.stderr)
        r = sql("INSERT INTO core.settings (params, changed_by) SELECT params, "
                "'00000000-0000-0000-0000-00000000000a' FROM core.settings ORDER BY version LIMIT 1", "argos_admin")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_version_des_regles_non_reecrivable(self):
        self.assertIn(REFUSE, sql("UPDATE core.settings SET params = '{}'", "argos_admin").stderr)

    def test_bannissement_marque_l_identite(self):
        valeur("UPDATE core.accounts SET status = 'banned' "
               "WHERE id = '00000000-0000-0000-0000-00000000000a'", "argos_admin")
        self.assertEqual(valeur("SELECT banned FROM identity.account_identities WHERE phone_hmac = '\\x01'"), "t")
        valeur("UPDATE core.accounts SET status = 'active' WHERE id = '00000000-0000-0000-0000-00000000000a'")

    # --- Nature des faits (0012) ------------------------------------------------

    def test_abus_non_violent_enregistre(self):
        r = sql("INSERT INTO core.videos (id, category, subcategory, upload_expires_at) VALUES "
                "('00000000-0000-0000-0000-0000000000f6', 'abuse', 'filming_obstruction', now() + interval '1 day')",
                "argos_app")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(valeur("SELECT category || '/' || subcategory FROM core.videos "
                                "WHERE id = '00000000-0000-0000-0000-0000000000f6'", "argos_app"),
                         "abuse/filming_obstruction")

    def test_sous_categorie_incoherente_refusee(self):
        for cat, sous in (("violence", "insults"), ("abuse", "weapons"), ("abuse", "inconnue")):
            with self.subTest(cat=cat, sous=sous):
                r = sql(f"INSERT INTO core.videos (category, subcategory) VALUES ('{cat}', '{sous}')", "argos_app")
                self.assertIn(CONTRAINTE, r.stderr)

if __name__ == "__main__":
    unittest.main()
