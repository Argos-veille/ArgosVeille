-- Journal légal SCELLÉ (15 novembre 2026, décision de l’administrateur). Le journal garde, pour chaque opération, l'adresse IP,
-- l'heure exacte, le compte et l'identifiant de la vidéo (décret 2021-1362, 0122) : en clair, une saisie du serveur
-- relierait directement chaque adresse IP à sa vidéo pour l'année écoulée. Désormais, ces données sont chiffrées
-- (OpenPGP à clé publique, pgcrypto) pour des clés dont la partie PRIVÉE n'est jamais sur le serveur : elles sont
-- gardées hors ligne et servent à déchiffrer la ligne demandée par une réquisition (deploiement/admin/ouvrir-journal-legal).
--   - DEUX détenteurs (clés 1 et 2) : chaque ligne est scellée pour chacun, séparément (pgcrypto n'accepte qu'un
--     destinataire). Une réquisition reste possible si l'un est absent ; chaque clé se remplace seule.
--   - Restent en clair : l'opération et son JOUR (heure de Paris), qui suffit à la purge ; l'heure exacte est scellée.
--   - Le texte scellé est complété à une longueur fixe : la taille ne dit ni IPv4/IPv6, ni avec ou sans compte.
--   - Une fois la clé posée (16-cle-journal-legal.sh), elle devient OBLIGATOIRE : sans elle, l'écriture échoue
--     (une opération refusée plutôt qu'un journal en clair). Avant (développement), écriture en clair ; 08 le signale.
-- Votes et messages ne sont pas journalisés : le décret ne vise que la création, la modification et la suppression d'un
-- contenu mis en ligne, pas les correspondances privées ni les votes (recherche Légifrance, 15 novembre 2026).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE identity.legal_seal_key (
    id          smallint PRIMARY KEY CHECK (id IN (1, 2)),   -- 1 : l’administrateur, 2 : second détenteur
    public_key  bytea NOT NULL,          -- clé publique OpenPGP (sous-clé de chiffrement RSA), sous forme binaire
    fingerprint text NOT NULL,           -- identifiant de la sous-clé de chiffrement, CALCULÉ par set_legal_seal_key
    set_at      timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON identity.legal_seal_key FROM PUBLIC;

-- Une seule ligne : « required » passe à vrai à la pose de la clé 1 et n'est remis à faux par aucun rôle applicatif.
CREATE TABLE identity.legal_seal_settings (
    id       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    required boolean NOT NULL DEFAULT false
);
INSERT INTO identity.legal_seal_settings DEFAULT VALUES;
REVOKE ALL ON identity.legal_seal_settings FROM PUBLIC;

ALTER TABLE identity.legal_connection_logs ALTER COLUMN ip DROP NOT NULL;
ALTER TABLE identity.legal_connection_logs ADD COLUMN sceau bytea;     -- pour la clé 1
ALTER TABLE identity.legal_connection_logs ADD COLUMN sceau_2 bytea;   -- pour la clé 2, si posée
-- Une ligne scellée ne garde rien en clair ; une ligne en clair a au moins son adresse.
ALTER TABLE identity.legal_connection_logs ADD CONSTRAINT legal_connection_logs_sceau_ou_clair
    CHECK ((sceau IS NOT NULL AND ip IS NULL AND source_port IS NULL AND account_id IS NULL AND content_id IS NULL)
        OR (sceau IS NULL AND sceau_2 IS NULL AND ip IS NOT NULL));
ALTER TABLE identity.legal_connection_logs DROP CONSTRAINT legal_connection_logs_action_check;
ALTER TABLE identity.legal_connection_logs ADD CONSTRAINT legal_connection_logs_action_check
    CHECK (action IN ('signup', 'login', 'upload', 'modify', 'delete')) NOT VALID;
ALTER TABLE identity.legal_connection_logs DROP CONSTRAINT legal_connection_logs_contenu;
ALTER TABLE identity.legal_connection_logs ADD CONSTRAINT legal_connection_logs_contenu
    CHECK (action NOT IN ('upload', 'modify', 'delete') OR content_id IS NOT NULL OR sceau IS NOT NULL) NOT VALID;

-- Contenu scellé : un objet JSON (adresse, port, compte, contenu, heure exacte), complété par des espaces à 320
-- caractères (le plus long fait environ 230), chiffré en AES-256 sans compression (la compression ferait dépendre la
-- taille du contenu), intégrité OpenPGP (MDC) gardée. NULL si la clé demandée n'est pas posée.
CREATE FUNCTION identity.legal_seal(p_ip inet, p_port integer, p_account uuid, p_content uuid, p_at timestamptz,
                                    p_key smallint) RETURNS bytea
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_cle bytea;
    v_texte text;
BEGIN
    SELECT public_key INTO v_cle FROM identity.legal_seal_key WHERE id = p_key;
    IF v_cle IS NULL THEN
        RETURN NULL;
    END IF;
    -- Heure en UTC explicite (« Z ») : ne dépend pas du fuseau de la session ; ouvrir-journal-legal la convertit.
    v_texte := jsonb_build_object('ip', host(p_ip), 'port', p_port, 'compte', p_account, 'contenu', p_content,
                                  'le', to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text;
    IF length(v_texte) > 320 THEN
        RAISE EXCEPTION 'argos:sceau_trop_long';   -- la taille du sceau ne doit rien dire de son contenu
    END IF;
    v_texte := v_texte || repeat(' ', 320 - length(v_texte));
    RETURN public.pgp_pub_encrypt(v_texte, v_cle, 'cipher-algo=aes256, compress-algo=0');
END $$;
REVOKE ALL ON FUNCTION identity.legal_seal(inet, integer, uuid, uuid, timestamptz, smallint) FROM PUBLIC;

-- Seul chemin d'écriture du journal légal (API et inscription). L'heure est celle de la base.
CREATE FUNCTION identity.log_legal(p_account uuid, p_action text, p_ip inet, p_port integer, p_content uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_le timestamptz := now();
    v_sceau bytea := identity.legal_seal(p_ip, p_port, p_account, p_content, v_le, 1::smallint);
BEGIN
    IF v_sceau IS NOT NULL THEN
        INSERT INTO identity.legal_connection_logs (occurred_at, action, sceau, sceau_2)
        VALUES (date_trunc('day', v_le, 'Europe/Paris'), p_action, v_sceau,
                identity.legal_seal(p_ip, p_port, p_account, p_content, v_le, 2::smallint));
    ELSIF (SELECT required FROM identity.legal_seal_settings WHERE id = 1) THEN
        RAISE EXCEPTION 'argos:journal_legal_sans_cle';
    ELSE
        INSERT INTO identity.legal_connection_logs (occurred_at, account_id, action, ip, source_port, content_id)
        VALUES (v_le, p_account, p_action, p_ip, p_port, p_content);
    END IF;
END $$;
REVOKE ALL ON FUNCTION identity.log_legal(uuid, text, inet, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.log_legal(uuid, text, inet, integer, uuid) TO argos_identity;
REVOKE INSERT ON identity.legal_connection_logs FROM argos_identity;
REVOKE USAGE ON SEQUENCE identity.legal_connection_logs_id_seq FROM argos_identity;

-- Pose ou remplacement d'une clé (propriétaire seulement, 16-cle-journal-legal.sh). Poser la clé 1 rend le sceau
-- obligatoire. Les lignes scellées avant la pose de la clé 2 ne s'ouvrent qu'avec la clé 1 (le serveur ne peut pas
-- les relire pour les sceller à nouveau) : poser les deux clés ensemble.
-- L'identifiant est calculé sur la clé (jamais fourni) ; 08 et la surveillance le recalculent aussi sur public_key.
CREATE FUNCTION identity.set_legal_seal_key(p_key smallint, p_public bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id text;
BEGIN
    -- Refuse une clé que pgcrypto ne sait pas utiliser (ECC, pas de sous-clé de chiffrement…).
    PERFORM public.pgp_pub_encrypt('essai', p_public, 'cipher-algo=aes256, compress-algo=0');
    v_id := upper(public.pgp_key_id(p_public));
    INSERT INTO identity.legal_seal_key (id, public_key, fingerprint) VALUES (p_key, p_public, v_id)
    ON CONFLICT (id) DO UPDATE SET public_key = excluded.public_key, fingerprint = excluded.fingerprint, set_at = now();
    IF p_key = 1 THEN
        UPDATE identity.legal_seal_settings SET required = true WHERE id = 1;
    END IF;
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION identity.set_legal_seal_key(smallint, bytea) FROM PUBLIC;

-- Une fois le sceau obligatoire, aucune ligne en clair n'entre, quel que soit le chemin (propriétaire, future fonction).
CREATE FUNCTION identity.guard_legal_clear() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NEW.sceau IS NULL AND (SELECT required FROM identity.legal_seal_settings WHERE id = 1) THEN
        RAISE EXCEPTION 'argos:journal_legal_sans_cle';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER legal_connection_logs_scelle BEFORE INSERT OR UPDATE ON identity.legal_connection_logs
    FOR EACH ROW EXECUTE FUNCTION identity.guard_legal_clear();

-- Lignes encore en clair (d'avant la clé) : scellées à leur tour, par le propriétaire (16-cle-journal-legal.sh, qui
-- réécrit ensuite la table avec VACUUM FULL : les anciennes versions des lignes ne restent pas dans ses pages).
CREATE FUNCTION identity.seal_existing_legal_logs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.legal_seal_key WHERE id = 1) THEN
        RAISE EXCEPTION 'argos:cle_journal_absente';
    END IF;
    UPDATE identity.legal_connection_logs
       SET sceau = identity.legal_seal(ip, source_port, account_id, content_id, occurred_at, 1::smallint),
           sceau_2 = identity.legal_seal(ip, source_port, account_id, content_id, occurred_at, 2::smallint),
           occurred_at = date_trunc('day', occurred_at, 'Europe/Paris'),
           ip = NULL, source_port = NULL, account_id = NULL, content_id = NULL
     WHERE sceau IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION identity.seal_existing_legal_logs() FROM PUBLIC;

-- Purge au jour (décret, art. 5 : « un an à compter du jour ») : une ligne part le lendemain de son premier anniversaire.
CREATE OR REPLACE FUNCTION identity.purge_legal_logs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM identity.legal_connection_logs
     WHERE occurred_at < date_trunc('day', now(), 'Europe/Paris') - interval '1 year 1 day';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;

CREATE OR REPLACE FUNCTION identity.create_reviewer(p_username text, p_password_hash text, p_phone_hmac bytea, p_email_hmac bytea, p_email_enc bytea, p_backup_hashes text[], p_ip inet, p_source_port integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
    v_id uuid;
BEGIN
    IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
        RAISE EXCEPTION 'empreinte de mot de passe invalide (Argon2id attendu)' USING ERRCODE = '22023';
    END IF;
    IF coalesce(cardinality(p_backup_hashes), 0) <> 10 THEN
        RAISE EXCEPTION '10 codes de secours attendus' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM identity.account_identities
                WHERE banned AND (phone_hmac = p_phone_hmac OR email_hmac = p_email_hmac)) THEN
        RAISE EXCEPTION 'numéro ou mail banni' USING ERRCODE = '42501';
    END IF;

    INSERT INTO core.accounts (username) VALUES (p_username) RETURNING id INTO v_id;
    INSERT INTO core.credentials (account_id, password_hash) VALUES (v_id, p_password_hash);
    INSERT INTO core.backup_codes (account_id, code_hash) SELECT v_id, h FROM unnest(p_backup_hashes) AS h;
    INSERT INTO identity.account_identities (account_id, phone_hmac, email_hmac, email_enc)
         VALUES (v_id, p_phone_hmac, p_email_hmac, p_email_enc);
    PERFORM identity.log_legal(v_id, 'signup', p_ip, p_source_port, NULL);
    RETURN v_id;
END
$function$;
