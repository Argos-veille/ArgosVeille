-- Droits de chaque rôle : le minimum nécessaire, accordé explicitement.

REVOKE ALL ON ALL TABLES IN SCHEMA identity, core, ledger FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA identity, core, ledger FROM PUBLIC;

-- Tout le monde peut lire et vérifier le journal public, personne ne peut y écrire directement.
GRANT USAGE ON SCHEMA ledger TO argos_app, argos_scoring, argos_admin, argos_worker;
GRANT SELECT ON ledger.entries, ledger.anchors TO argos_app, argos_scoring, argos_admin;
GRANT EXECUTE ON FUNCTION ledger.verify(), ledger.entry_hash(bytea, text, jsonb, timestamptz)
      TO argos_app, argos_scoring, argos_admin;
GRANT EXECUTE ON FUNCTION ledger.append(text, jsonb) TO argos_app, argos_scoring, argos_admin, argos_worker;

-- argos_identity : uniquement le schéma identity.
GRANT USAGE ON SCHEMA identity TO argos_identity;
GRANT SELECT, INSERT, UPDATE ON identity.account_identities TO argos_identity;
GRANT INSERT ON identity.legal_connection_logs TO argos_identity;
GRANT USAGE ON SEQUENCE identity.legal_connection_logs_id_seq TO argos_identity;

-- argos_app : le site public. Aucun accès à identity, ne lit ni les votes ni le lien compte-vidéo.
GRANT USAGE ON SCHEMA core TO argos_app;
-- Comptes : lecture seule (score, statut). Ni le score ni le rôle de super-administrateur ne sont modifiables.
GRANT SELECT (id, created_at, status, suspended_until, score, last_vote_at) ON core.accounts TO argos_app;
GRANT INSERT (id) ON core.accounts TO argos_app;
GRANT SELECT, INSERT, UPDATE ON core.credentials, core.sessions, core.mfa_factors, core.backup_codes TO argos_app;
-- Vidéos : le site saisit le contexte, mais ne voit pas la bonne réponse des vidéos de contrôle
-- et ne peut pas décider (transitions de statut contrôlées par core.guard_video_status, 0010).
GRANT SELECT (id, submitted_at, status, is_control, occurred_at, location, location_precision, forces,
              situation, description, language, description_mt, original_sha256, blurred_sha256,
              timestamp_token, r2_blurred_key, enlargements, decided_at, decided_by_stage)
      ON core.videos TO argos_app;
GRANT INSERT (id, occurred_at, location, location_precision, forces, situation, description, language,
              original_sha256, r2_original_enc_key)
      ON core.videos TO argos_app;
GRANT UPDATE (status, occurred_at, location, location_precision, forces, situation, description, language,
              description_mt)
      ON core.videos TO argos_app;
GRANT INSERT ON core.pseudonyms TO argos_app;
GRANT SELECT (id, video_id, pseudonym, contact_allowed) ON core.pseudonyms TO argos_app;
GRANT UPDATE (contact_allowed) ON core.pseudonyms TO argos_app;
GRANT SELECT, INSERT ON core.events, core.event_links TO argos_app;
GRANT SELECT, UPDATE (answered_at, outcome) ON core.summons TO argos_app;
GRANT INSERT ON core.votes TO argos_app;
GRANT SELECT ON core.settings, core.groups TO argos_app;
GRANT SELECT ON core.verifications TO argos_app;
GRANT SELECT, INSERT ON core.public_keys, core.conversations TO argos_app;
GRANT SELECT, INSERT ON core.messages TO argos_app;
GRANT UPDATE (reported_at, revealed_text) ON core.messages TO argos_app;
GRANT INSERT ON core.reports, core.replies TO argos_app;

-- argos_worker : uniquement les champs techniques des vidéos.
GRANT USAGE ON SCHEMA core TO argos_worker;
GRANT SELECT (id, status, r2_blurred_key, r2_original_enc_key, original_sha256) ON core.videos TO argos_worker;
GRANT UPDATE (status, r2_blurred_key, blurred_sha256, timestamp_token) ON core.videos TO argos_worker;

-- argos_scoring : seul rôle qui relie votes et comptes, pour les décisions et les scores.
GRANT USAGE ON SCHEMA core TO argos_scoring;
GRANT SELECT ON core.votes, core.settings, core.pseudonyms TO argos_scoring;
GRANT SELECT, INSERT, UPDATE ON core.summons TO argos_scoring;
GRANT SELECT (id, created_at, status, score, last_vote_at, suspect) ON core.accounts TO argos_scoring;
GRANT UPDATE (score, last_vote_at, suspect) ON core.accounts TO argos_scoring;
GRANT SELECT, UPDATE (status, enlargements, first_round_ratio, decided_at, decided_by_stage)
      ON core.videos TO argos_scoring;
GRANT SELECT, INSERT, UPDATE ON core.collusion_pairs TO argos_scoring;
GRANT EXECUTE ON FUNCTION core.unlink_old_votes(integer) TO argos_scoring;

-- argos_admin : administration. Ne lit ni les votes, ni les messages chiffrés, ni l'identité.
GRANT USAGE ON SCHEMA core TO argos_admin;
GRANT SELECT (id, created_at, status, suspended_until, suspect, is_superadmin) ON core.accounts TO argos_admin;
GRANT UPDATE (status, suspended_until) ON core.accounts TO argos_admin;
GRANT SELECT, UPDATE (revoked_at) ON core.sessions TO argos_admin;
GRANT SELECT, INSERT, UPDATE ON core.admin_rights, core.group_members, core.sanctions,
      core.invitations, core.verifications TO argos_admin;
GRANT SELECT ON core.groups TO argos_admin;
GRANT SELECT, UPDATE ON core.reports, core.replies TO argos_admin;
GRANT SELECT (id, status, submitted_at) ON core.videos TO argos_admin;
GRANT UPDATE (status, decided_at, decided_by_stage) ON core.videos TO argos_admin;   -- retrait pour motif légal
GRANT INSERT, UPDATE ON core.settings TO argos_admin;
GRANT USAGE ON SEQUENCE core.settings_version_seq TO argos_admin;
