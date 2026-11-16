-- Convocations des relecteurs (étape 7a, 4 novembre 2026).
--
-- Quand une vidéo est « en relecture », le moteur de relecture (rôle argos_scoring, processus à part
-- du site) convoque au hasard 3 comptes par place à pourvoir (15 places, plus en cas d'élargissement),
-- parmi les comptes actifs qui n'ont pas atteint 5 relectures sur les dernières 24 h. Une
-- convocation expire au bout de 2 jours ; le moteur en tire alors d'autres. Le tirage utilise
-- gen_random_uuid() (générateur aléatoire sûr de PostgreSQL) : imprévisible, non orientable.

ALTER TABLE core.accounts
    -- Mail « une vidéo attend votre relecture » : activé par défaut, au plus un par jour.
    ADD COLUMN notify_summons      boolean NOT NULL DEFAULT true,
    ADD COLUMN summons_notified_at timestamptz;

GRANT SELECT (notify_summons, summons_notified_at), UPDATE (notify_summons, summons_notified_at)
      ON core.accounts TO argos_app;
GRANT SELECT (metadata_check) ON core.videos TO argos_scoring;

CREATE INDEX summons_video_pending ON core.summons (video_id, round) WHERE outcome = 'pending';
CREATE INDEX votes_account_recent ON core.votes (account_id, cast_at);

-- Le site ne peut que « passer » une convocation en attente et encore valable (le vote passe par
-- core.votes, dont le déclencheur marque la convocation). Jamais l'inverse, jamais une autre issue.
CREATE FUNCTION core.guard_summons_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_user = 'argos_owner' OR core.acting_as('argos_scoring') THEN
        RETURN NEW;
    END IF;
    IF OLD.outcome = 'pending' AND NEW.outcome = 'passed' AND OLD.expires_at > now()
       AND NEW.answered_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'changement de convocation interdit : % -> %', OLD.outcome, NEW.outcome;
END $$;
CREATE TRIGGER summons_guard_update BEFORE UPDATE ON core.summons
    FOR EACH ROW EXECUTE FUNCTION core.guard_summons_update();
REVOKE ALL ON FUNCTION core.guard_summons_update() FROM PUBLIC;

-- Tirage : expire les convocations dépassées, puis complète celles de chaque vidéo en relecture.
-- Renvoie le nombre de convocations envoyées.
CREATE FUNCTION core.draw_summons() RETURNS integer
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

    FOR v IN SELECT id, enlargements FROM core.videos WHERE status = 'in_review'
              ORDER BY submitted_at FOR UPDATE SKIP LOCKED LOOP
        places := (p ->> 'sample_size')::int * (1 + v.enlargements)
                  - (SELECT count(*) FROM core.votes WHERE video_id = v.id AND round = 'review');
        CONTINUE WHEN places <= 0;
        manque := places * (p ->> 'summons_per_seat')::int
                  - (SELECT count(*) FROM core.summons WHERE video_id = v.id AND round = 'review' AND outcome = 'pending');
        CONTINUE WHEN manque <= 0;

        INSERT INTO core.summons (video_id, account_id, round, expires_at)
        SELECT v.id, a.id, 'review', now() + make_interval(days => (p ->> 'summons_days')::int)
          FROM core.accounts a
         WHERE a.status = 'active'
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

REVOKE ALL ON FUNCTION core.draw_summons() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.draw_summons() TO argos_scoring;
