-- Garde-fous d'intégrité dans la base elle-même : même un service compromis ne peut pas
-- publier une vidéo ou gonfler le poids d'un vote.

-- Vrai si l'utilisateur courant agit avec les droits du rôle indiqué (ou est le propriétaire).
CREATE FUNCTION core.acting_as(p_role text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user = 'argos_owner' OR pg_has_role(current_user, p_role, 'USAGE')
$$;

-- Chaque rôle ne peut faire que ses propres transitions de statut.
CREATE FUNCTION core.guard_video_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR current_user = 'argos_owner' THEN
        RETURN NEW;
    END IF;
    IF core.acting_as('argos_worker') AND OLD.status = 'processing' AND NEW.status = 'awaiting_author' THEN
        RETURN NEW;   -- floutage terminé
    END IF;
    IF core.acting_as('argos_app') AND OLD.status = 'awaiting_author' AND NEW.status = 'in_review' THEN
        RETURN NEW;   -- l'auteur valide le floutage
    END IF;
    IF core.acting_as('argos_scoring') AND OLD.status IN ('in_review', 'jury')
       AND NEW.status IN ('jury', 'published', 'rejected', 'under_debate', 'no_decision') THEN
        RETURN NEW;   -- décision communautaire
    END IF;
    IF core.acting_as('argos_admin') AND NEW.status IN ('hidden', 'removed') THEN
        RETURN NEW;   -- masquage ou retrait pour motif légal
    END IF;
    IF core.acting_as('argos_admin') AND OLD.status = 'hidden'
       AND NEW.status IN ('in_review', 'published', 'under_debate') THEN
        RETURN NEW;   -- rétablissement après un masquage d'urgence
    END IF;
    RAISE EXCEPTION 'transition de statut interdite pour %: % -> %', current_user, OLD.status, NEW.status;
END
$$;
CREATE TRIGGER videos_guard_status BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.guard_video_status();

-- Une vidéo de contrôle ne peut pas être créée par le site public.
CREATE FUNCTION core.guard_video_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'processing' AND current_user <> 'argos_owner' THEN
        RAISE EXCEPTION 'une vidéo commence toujours au statut processing';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER videos_guard_insert BEFORE INSERT ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.guard_video_insert();

-- Le poids d'un vote est calculé par la base à partir du score, jamais fourni par le service.
CREATE FUNCTION core.compute_vote_weight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    v_score    numeric;
    v_created  timestamptz;
    v_params   jsonb;
BEGIN
    SELECT score, created_at INTO v_score, v_created FROM core.accounts WHERE id = NEW.account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'compte inconnu pour ce vote';
    END IF;
    SELECT params INTO v_params FROM core.settings ORDER BY version DESC LIMIT 1;
    NEW.weight := v_score;
    IF now() - v_created < make_interval(days => (v_params ->> 'novice_days')::int) THEN
        NEW.weight := v_score * (v_params ->> 'novice_factor')::numeric;
    END IF;
    NEW.cast_at := now();
    RETURN NEW;
END
$$;
CREATE TRIGGER votes_compute_weight BEFORE INSERT ON core.votes
    FOR EACH ROW EXECUTE FUNCTION core.compute_vote_weight();

REVOKE ALL ON FUNCTION core.acting_as(text), core.guard_video_status(), core.guard_video_insert(),
                       core.compute_vote_weight() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.acting_as(text) TO argos_app, argos_worker, argos_scoring, argos_admin;
