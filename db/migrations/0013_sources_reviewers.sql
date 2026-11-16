-- Protection des sources et assouplissement des comptes de relecture (décisions du 4 novembre 2026).
--
-- 1. Les sources envoient sans compte : plus aucun lien entre une vidéo et un compte.
--    La vidéo est rattachée à l'empreinte d'un code de suivi secret, un code par vidéo.
-- 2. Les relecteurs choisissent un pseudo, qui sert d'identifiant de connexion.
-- 3. Le téléphone reste vérifié et conservé en HMAC (doublons, bannissements). Le mail devient
--    facultatif, conservé chiffré pour les convocations, les alertes et la récupération du mot de passe.

-- 1. Sources ------------------------------------------------------------------------------------

ALTER TABLE core.pseudonyms DROP COLUMN account_id;

-- SHA-256 du code de suivi. Le code est une phrase aléatoire de forte entropie générée dans le
-- navigateur : une empreinte simple suffit et permet de retrouver la vidéo à partir du code.
ALTER TABLE core.pseudonyms
    ADD COLUMN tracking_code_hash bytea NOT NULL UNIQUE CHECK (length(tracking_code_hash) = 32);

COMMENT ON TABLE core.pseudonyms IS
    'Un pseudonyme aléatoire par vidéo. Aucun lien avec un compte : la source n''est connue que par '
    'l''empreinte de son code de suivi.';

-- 2. Pseudo des relecteurs ----------------------------------------------------------------------

-- 3 à 30 caractères : lettres (accents compris), chiffres, point, tiret, tiret bas.
-- Le filtre contre les pseudos injurieux est appliqué par l'application.
ALTER TABLE core.accounts
    ADD COLUMN username text NOT NULL
        CHECK (username ~ '^[[:alnum:]._-]{3,30}$');

-- Unicité sans tenir compte de la casse : « Corbeau » et « corbeau » sont le même pseudo.
CREATE UNIQUE INDEX accounts_username_ci ON core.accounts (lower(username));

-- 3. Identité : téléphone en HMAC, mail facultatif chiffré ----------------------------------------

ALTER TABLE identity.account_identities DROP COLUMN email_hmac;
ALTER TABLE identity.account_identities
    ADD COLUMN email_enc         bytea,        -- chiffré par l'application (clé distincte de la clé HMAC)
    ADD COLUMN email_verified_at timestamptz,
    ADD CONSTRAINT email_verified_needs_email CHECK (email_verified_at IS NULL OR email_enc IS NOT NULL);

COMMENT ON COLUMN identity.account_identities.email_enc IS
    'Mail facultatif du relecteur, chiffré. Sert uniquement aux convocations, aux alertes de sécurité '
    'et à la récupération du mot de passe.';

-- Droits ----------------------------------------------------------------------------------------

-- Le site crée le compte avec son pseudo, le lit pour la connexion, et le relecteur peut en changer.
GRANT INSERT (id, username) ON core.accounts TO argos_app;
GRANT SELECT (username), UPDATE (username) ON core.accounts TO argos_app;
-- L'administration voit le pseudo et peut imposer un changement (pseudo injurieux).
GRANT SELECT (username), UPDATE (username) ON core.accounts TO argos_admin;

-- Le site retrouve une vidéo à partir du code de suivi, et l'enregistre à l'envoi.
GRANT SELECT (tracking_code_hash) ON core.pseudonyms TO argos_app;
-- Le calcul des scores n'a aucune raison de connaître les codes de suivi.
REVOKE SELECT ON core.pseudonyms FROM argos_scoring;
GRANT SELECT (id, video_id, pseudonym) ON core.pseudonyms TO argos_scoring;
