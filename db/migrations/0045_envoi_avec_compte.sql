-- Envoi avec son compte (étape 2, 7 novembre 2026, choix de l’administrateur) :
--   - facultatif : l'envoi anonyme (code de 12 mots) reste possible et inchangé ;
--   - le lien compte ↔ vidéo est gardé tant que le compte existe (la personne est prévenue), effacé
--     quand le compte est effacé définitivement (la vidéo redevient anonyme) ;
--   - « Mes vidéos » remplace le code de suivi : la base retrouve l'empreinte du code à partir du lien ;
--   - la clé de la copie de travail (retouche du floutage) est gardée chiffrée par le site ;
--   - on n'est jamais convoqué (relecture ni jury) pour sa propre vidéo ;
--   - option « ne pas me convoquer pour relire » pour qui veut seulement envoyer.
-- Le site (argos_app) ne lit pas la table directement : seulement par les fonctions ci-dessous.

ALTER TABLE core.accounts ADD COLUMN review_opt_out boolean NOT NULL DEFAULT false;
GRANT SELECT (review_opt_out) ON core.accounts TO argos_app;

CREATE TABLE core.video_owners (
    video_id     uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    account_id   uuid NOT NULL REFERENCES core.accounts (id),
    copy_key_enc bytea,                              -- clé de la copie de travail, chiffrée par le site
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_owners_account ON core.video_owners (account_id);
REVOKE ALL ON core.video_owners FROM PUBLIC;

-- Rattacher un envoi qui vient d'être ouvert (statut « uploading ») au compte connecté.
CREATE FUNCTION core.claim_video(p_account uuid, p_video uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video AND status = 'uploading') THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    INSERT INTO core.video_owners (video_id, account_id) VALUES (p_video, p_account);
END $$;

-- Clé de la copie de travail, reçue à la finalisation de l'envoi (vidéos rattachées à un compte seulement).
CREATE FUNCTION core.set_owner_copy_key(p_video uuid, p_key_enc bytea) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.video_owners SET copy_key_enc = p_key_enc WHERE video_id = p_video RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m)
$$;

-- Les vidéos d'un compte, les plus récentes d'abord.
CREATE FUNCTION core.my_videos(p_account uuid)
RETURNS TABLE (video_id uuid, pseudonym text, status text, submitted_at timestamptz, decided_at timestamptz,
               withdrawn_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.id, p.pseudonym, v.status, v.submitted_at, v.decided_at, v.withdrawn_at
      FROM core.video_owners o
      JOIN core.videos v ON v.id = o.video_id
      JOIN core.pseudonyms p ON p.video_id = v.id
     WHERE o.account_id = p_account
     ORDER BY v.submitted_at DESC
$$;

-- Une vidéo du compte : l'empreinte de son code de suivi (pour réutiliser le suivi) et la clé de copie.
-- Rien si la vidéo n'appartient pas à ce compte.
CREATE FUNCTION core.owned_video(p_account uuid, p_video uuid)
RETURNS TABLE (tracking_code_hash bytea, copy_key_enc bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT p.tracking_code_hash, o.copy_key_enc
      FROM core.video_owners o
      JOIN core.pseudonyms p ON p.video_id = o.video_id
      JOIN core.accounts a ON a.id = o.account_id
     WHERE o.account_id = p_account AND o.video_id = p_video AND a.status = 'active'
$$;

-- Compte effacé définitivement (core.purge_closed_accounts) : ses vidéos redeviennent anonymes.
CREATE FUNCTION core.forget_video_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_owners WHERE account_id = NEW.id;
    RETURN NULL;
END $$;
CREATE TRIGGER accounts_forget_video_owner AFTER UPDATE OF status ON core.accounts
    FOR EACH ROW WHEN (NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted')
    EXECUTE FUNCTION core.forget_video_owner();

REVOKE ALL ON FUNCTION core.claim_video(uuid, uuid), core.set_owner_copy_key(uuid, bytea), core.my_videos(uuid),
                       core.owned_video(uuid, uuid), core.forget_video_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.claim_video(uuid, uuid), core.set_owner_copy_key(uuid, bytea), core.my_videos(uuid),
                          core.owned_video(uuid, uuid) TO argos_app;

-- « Ne pas me convoquer pour relire » : les convocations en attente sont annulées (d'autres relecteurs
-- seront tirés à la place).
CREATE FUNCTION core.set_review_opt_out(p_account uuid, p_opt_out boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.accounts SET review_opt_out = p_opt_out WHERE id = p_account;
    IF p_opt_out THEN
        UPDATE core.summons SET outcome = 'cancelled' WHERE account_id = p_account AND outcome = 'pending';
    END IF;
END $$;
REVOKE ALL ON FUNCTION core.set_review_opt_out(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.set_review_opt_out(uuid, boolean) TO argos_app;

-- Tirages : ni sa propre vidéo, ni personne qui a demandé à ne pas être convoqué.
CREATE OR REPLACE FUNCTION core.draw_summons() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p      jsonb;
    v      record;
    places integer;
    manque integer;
    ajout  integer;
    total  integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    UPDATE core.summons SET outcome = 'expired' WHERE outcome = 'pending' AND expires_at <= now();

    FOR v IN SELECT id FROM core.videos WHERE status = 'in_review'
              ORDER BY submitted_at FOR UPDATE SKIP LOCKED LOOP
        places := core.review_seats(v.id)
                  - (SELECT count(*) FROM core.votes WHERE video_id = v.id AND round = 'review');
        CONTINUE WHEN places <= 0;
        manque := places * (p ->> 'summons_per_seat')::int
                  - (SELECT count(*) FROM core.summons WHERE video_id = v.id AND round = 'review' AND outcome = 'pending');
        CONTINUE WHEN manque <= 0;

        INSERT INTO core.summons (video_id, account_id, round, expires_at)
        SELECT v.id, a.id, 'review', now() + make_interval(days => (p ->> 'summons_days')::int)
          FROM core.accounts a
         WHERE a.status = 'active'
           AND NOT a.review_opt_out                                                     -- « ne pas me convoquer »
           AND NOT EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = v.id AND o.account_id = a.id)  -- sa propre vidéo
           AND NOT EXISTS (SELECT 1 FROM core.summons s
                            WHERE s.video_id = v.id AND s.account_id = a.id AND s.round = 'review')
           AND (SELECT count(*) FROM core.votes vo
                 WHERE vo.account_id = a.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
         ORDER BY gen_random_uuid()
         LIMIT manque;
        GET DIAGNOSTICS ajout = ROW_COUNT;
        total := total + ajout;
    END LOOP;
    RETURN total;
END
$$;

CREATE OR REPLACE FUNCTION core.jury_pool(p_video uuid, p jsonb) RETURNS TABLE (account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH anciens AS (
        SELECT a.id, a.score
          FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect AND NOT a.review_opt_out
           AND a.created_at <= now() - make_interval(days => (p ->> 'jury_min_age_days')::int)
           AND EXISTS (SELECT 1 FROM core.mfa_factors f WHERE f.account_id = a.id AND f.revoked_at IS NULL)
    ), haut AS (
        SELECT id FROM anciens
         ORDER BY score DESC, id
         LIMIT ceil((SELECT count(*) FROM anciens) * (p ->> 'jury_pool_share')::numeric)::int
    )
    SELECT h.id FROM haut h
     WHERE NOT EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = p_video AND o.account_id = h.id)
       AND NOT EXISTS (SELECT 1 FROM core.summons s
                        WHERE s.video_id = p_video AND s.account_id = h.id)   -- premier tour, ou déjà convoqué au jury
       AND (SELECT count(*) FROM core.summons s
             WHERE s.account_id = h.id AND s.round = 'jury' AND s.outcome IN ('pending', 'voted')
               AND s.sent_at > now() - make_interval(days => 7)) < (p ->> 'jury_max_per_week')::int
       AND (SELECT count(*) FROM core.votes vo
             WHERE vo.account_id = h.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
$$;
