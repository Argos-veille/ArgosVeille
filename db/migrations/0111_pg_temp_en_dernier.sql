-- Point bas de la revue (15 novembre 2026) : fonctions SECURITY DEFINER dont le search_path ne nommait pas pg_temp.
-- PostgreSQL cherche alors d'abord dans le schéma temporaire de la session : un objet temporaire du même nom pourrait
-- y prendre la place d'une table ou d'une fonction. pg_temp est désormais nommé, en dernier (non exploitable
-- aujourd'hui : aucun rôle applicatif ne peut créer d'objet temporaire utile ici, mais la règle vaut partout).
ALTER FUNCTION ledger.append(text, jsonb) SET search_path = ledger, public, pg_temp;
ALTER FUNCTION ledger.write(text, jsonb) SET search_path = ledger, public, pg_temp;
ALTER FUNCTION ledger.flush_pending(boolean) SET search_path = ledger, public, pg_temp;
ALTER FUNCTION core.unlink_old_votes(integer) SET search_path = core, public, pg_temp;
ALTER FUNCTION core.compute_vote_weight() SET search_path = core, public, pg_temp;
ALTER FUNCTION core.log_video_status() SET search_path = core, public, pg_temp;
ALTER FUNCTION core.log_admin_action() SET search_path = core, public, pg_temp;
ALTER FUNCTION core.require_superadmin() SET search_path = core, public, pg_temp;
ALTER FUNCTION core.propagate_ban() SET search_path = core, identity, public, pg_temp;
ALTER FUNCTION core.event_suggestions(uuid, integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION identity.purge_legal_logs() SET search_path = identity, public, pg_temp;
