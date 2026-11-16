-- Revue de sécurité du 14 novembre 2026 (correctifs avant l'ouverture publique).

-- A2 : personne n'écrit plus au journal public directement. Seules les fonctions de la base (propriétaire) y écrivent,
-- après leurs propres vérifications ; un site, un worker ou un moteur compromis ne peut plus y glisser de fausses entrées.
REVOKE EXECUTE ON FUNCTION ledger.append(text, jsonb) FROM argos_app, argos_scoring, argos_admin, argos_worker;

-- B1 : masquage, retrait et rétablissement après masquage sont des gestes de l'administration : inscrits en différé
-- comme les autres (avant : tout de suite, avec l'étape de la décision précédente).
CREATE OR REPLACE FUNCTION ledger.append(p_kind text, p_payload jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, public
AS $$
DECLARE
    v_payload jsonb := p_payload - 'analyst';
BEGIN
    IF p_kind IN ('withdrawal', 'original_shared', 'admin_action', 'removal')
       OR (p_kind = 'decision' AND (v_payload ->> 'stage' IN ('legal', 'admin') OR v_payload ->> 'from' = 'hidden')) THEN
        INSERT INTO ledger.pending (due_at, kind, payload)
        VALUES (now() + random() * interval '24 hours', p_kind, v_payload);
        RETURN NULL;
    END IF;
    RETURN ledger.write(p_kind, v_payload);
END
$$;

-- Basse : la durée de conservation du journal légal n'est plus réglable par l'appelant (« 0 » effaçait tout).
DROP FUNCTION identity.purge_legal_logs(interval);
CREATE FUNCTION identity.purge_legal_logs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, public
AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM identity.legal_connection_logs WHERE occurred_at < now() - interval '1 year';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;
REVOKE ALL ON FUNCTION identity.purge_legal_logs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.purge_legal_logs() TO argos_identity;
