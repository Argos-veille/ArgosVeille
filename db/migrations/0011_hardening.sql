-- Durcissement après revue : on suppose le site public compromis et on limite ce qu'il peut faire.

-- 1. Sessions : le site public ne crée jamais de session d'administration et ne peut pas
--    réactiver une session révoquée. L'administration authentifie elle-même ses connexions.
REVOKE INSERT, UPDATE ON core.sessions FROM argos_app;
GRANT INSERT (id, account_id, expires_at) ON core.sessions TO argos_app;
GRANT UPDATE (revoked_at) ON core.sessions TO argos_app;
GRANT INSERT (id, account_id, expires_at, is_admin) ON core.sessions TO argos_admin;
GRANT SELECT ON core.credentials, core.mfa_factors TO argos_admin;
GRANT UPDATE (last_used_at, sign_count) ON core.mfa_factors TO argos_admin;

CREATE FUNCTION core.forbid_unrevoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'une session révoquée ne peut pas être réactivée';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER sessions_forbid_unrevoke BEFORE UPDATE OF revoked_at ON core.sessions
    FOR EACH ROW EXECUTE FUNCTION core.forbid_unrevoke();

-- 2. Votes : un vote doit correspondre exactement à une convocation en attente et non expirée,
--    du même compte, de la même vidéo et du même tour, et venir d'un compte actif.
--    Le poids est recalculé, et la convocation est marquée comme votée.
CREATE OR REPLACE FUNCTION core.compute_vote_weight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    v_summons  core.summons%ROWTYPE;
    v_score    numeric;
    v_created  timestamptz;
    v_status   text;
    v_params   jsonb;
BEGIN
    SELECT * INTO v_summons FROM core.summons WHERE id = NEW.summons_id FOR UPDATE;
    IF NOT FOUND
       OR v_summons.account_id IS DISTINCT FROM NEW.account_id
       OR v_summons.video_id <> NEW.video_id
       OR v_summons.round <> NEW.round THEN
        RAISE EXCEPTION 'vote sans convocation correspondante';
    END IF;
    IF v_summons.outcome <> 'pending' OR v_summons.expires_at < now() THEN
        RAISE EXCEPTION 'convocation déjà utilisée ou expirée';
    END IF;

    SELECT score, created_at, status INTO v_score, v_created, v_status
    FROM core.accounts WHERE id = NEW.account_id;
    IF v_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'seul un compte actif peut voter';
    END IF;

    SELECT params INTO v_params FROM core.settings ORDER BY version DESC LIMIT 1;
    NEW.weight := v_score;
    IF now() - v_created < make_interval(days => (v_params ->> 'novice_days')::int) THEN
        NEW.weight := v_score * (v_params ->> 'novice_factor')::numeric;
    END IF;
    NEW.cast_at := now();

    UPDATE core.summons SET outcome = 'voted', answered_at = now() WHERE id = NEW.summons_id;
    UPDATE core.accounts SET last_vote_at = now() WHERE id = NEW.account_id;
    RETURN NEW;
END
$$;

-- 3. Liens d'événement : le site propose, seuls les relecteurs (via le calcul des décisions) valident.
REVOKE INSERT ON core.event_links FROM argos_app;
GRANT INSERT (id, event_id, video_id) ON core.event_links TO argos_app;
GRANT SELECT, UPDATE (status) ON core.event_links TO argos_scoring;

-- 4. Signalements et droits de réponse : le site ne peut que les déposer, jamais les traiter.
REVOKE INSERT ON core.reports, core.replies FROM argos_app;
GRANT INSERT (id, video_id, severity, reason_code, details) ON core.reports TO argos_app;
GRANT INSERT (id, video_id, content) ON core.replies TO argos_app;

-- 5. Messagerie : une conversation n'existe que si le témoin a accepté le contact pour cette vidéo
--    et si le compte qui écrit a une vérification active.
CREATE FUNCTION core.guard_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.pseudonyms WHERE id = NEW.pseudonym_id AND contact_allowed) THEN
        RAISE EXCEPTION 'ce témoin n''accepte pas d''être contacté';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.verifications
                   WHERE account_id = NEW.verified_account_id
                     AND revoked_at IS NULL AND expires_at > now()) THEN
        RAISE EXCEPTION 'seul un compte vérifié peut contacter un témoin';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER conversations_guard BEFORE INSERT ON core.conversations
    FOR EACH ROW EXECUTE FUNCTION core.guard_conversation();

-- 6. Journal public automatique : la base inscrit elle-même les décisions et les actions
--    d'administration. Aucune donnée personnelle : ni compte, ni pseudonyme.
CREATE FUNCTION core.log_video_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status IN ('published', 'rejected', 'under_debate', 'no_decision', 'hidden', 'removed')
       AND NOT NEW.is_control THEN
        PERFORM ledger.append(
            CASE WHEN NEW.status IN ('hidden', 'removed') THEN 'removal' ELSE 'decision' END,
            jsonb_build_object('video', NEW.id, 'status', NEW.status, 'from', OLD.status,
                               'stage', NEW.decided_by_stage));
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER videos_log_status AFTER UPDATE OF status ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.log_video_status();

CREATE FUNCTION core.log_admin_action() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
-- Tests imbriqués par table : PL/pgSQL refuse de lire un champ absent de la table déclencheuse.
BEGIN
    IF TG_TABLE_NAME = 'sanctions' THEN
        PERFORM ledger.append('admin_action', jsonb_build_object(
            'action', 'sanction', 'kind', NEW.kind, 'reason', NEW.reason_code));
    ELSIF TG_TABLE_NAME = 'admin_rights' THEN
        IF TG_OP = 'INSERT' THEN
            PERFORM ledger.append('admin_action', jsonb_build_object(
                'action', 'right_granted', 'right', NEW.right_code, 'expires', NEW.expires_at));
        ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
            PERFORM ledger.append('admin_action', jsonb_build_object(
                'action', 'right_revoked', 'right', NEW.right_code));
        END IF;
    ELSIF TG_TABLE_NAME = 'verifications' THEN
        PERFORM ledger.append('admin_action', jsonb_build_object(
            'action', 'verification', 'category', NEW.category));
    ELSIF TG_TABLE_NAME = 'settings' THEN
        PERFORM ledger.append('rule_change', jsonb_build_object('version', NEW.version, 'params', NEW.params));
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER sanctions_log AFTER INSERT ON core.sanctions
    FOR EACH ROW EXECUTE FUNCTION core.log_admin_action();
CREATE TRIGGER admin_rights_log AFTER INSERT OR UPDATE OF revoked_at ON core.admin_rights
    FOR EACH ROW EXECUTE FUNCTION core.log_admin_action();
CREATE TRIGGER verifications_log AFTER INSERT ON core.verifications
    FOR EACH ROW EXECUTE FUNCTION core.log_admin_action();
CREATE TRIGGER settings_log AFTER INSERT ON core.settings
    FOR EACH ROW EXECUTE FUNCTION core.log_admin_action();

-- 7. Seul le super-administrateur modifie les règles et délègue des droits.
--    Limite connue : la base fait confiance à l'identifiant transmis par le service d'administration ;
--    la vraie garantie vient de l'authentification forte et du journal public ci-dessus.
CREATE FUNCTION core.require_superadmin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    -- Lecture par jsonb : les deux tables n'ont pas la même colonne, et PL/pgSQL refuse
    -- d'accéder à un champ absent, même dans une branche non exécutée.
    v_actor uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'settings' THEN 'changed_by'
                                                          ELSE 'granted_by' END)::uuid;
BEGIN
    -- Pas d'exception pour le propriétaire : dans une fonction SECURITY DEFINER, current_user vaut
    -- toujours le propriétaire, ce qui contournerait la vérification pour tout le monde.
    -- Les règles initiales (0004) sont insérées avant la création de ce garde-fou.
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = v_actor AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'action réservée au super-administrateur';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER settings_require_superadmin BEFORE INSERT ON core.settings
    FOR EACH ROW EXECUTE FUNCTION core.require_superadmin();
CREATE TRIGGER admin_rights_require_superadmin BEFORE INSERT ON core.admin_rights
    FOR EACH ROW EXECUTE FUNCTION core.require_superadmin();

-- 8. Un bannissement marque aussi l'empreinte d'identité, qui survit à la suppression du compte.
CREATE FUNCTION core.propagate_ban() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, identity, public
AS $$
BEGIN
    IF NEW.status = 'banned' AND OLD.status IS DISTINCT FROM 'banned' THEN
        UPDATE identity.account_identities SET banned = true WHERE account_id = NEW.id;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER accounts_propagate_ban AFTER UPDATE OF status ON core.accounts
    FOR EACH ROW EXECUTE FUNCTION core.propagate_ban();

REVOKE ALL ON FUNCTION core.forbid_unrevoke(), core.guard_conversation(), core.log_video_status(),
                       core.log_admin_action(), core.require_superadmin(), core.propagate_ban() FROM PUBLIC;

-- 9. Règles : l'administration les lit, et en ajoute une nouvelle version ; jamais de réécriture
--    d'une version existante, qui effacerait l'historique.
REVOKE UPDATE ON core.settings FROM argos_admin;
GRANT SELECT ON core.settings TO argos_admin;
