-- Journal public et anonymat (14 novembre 2026, demande de l’administrateur) :
--   1. Inscription DIFFÉRÉE des actions qui dateraient une personne : retrait ou partage d'original par la source,
--      actions de l'administration (et ses décisions sur les vidéos). L'entrée attend dans ledger.pending et le
--      moteur l'inscrit à une heure tirée au hasard dans les 24 heures : l'horodatage du journal ne donne plus
--      l'heure de l'action, ni les horaires de l'administration. Les décisions de la relecture et du jury, et les
--      changements de règles (qui s'appliquent aussitôt), restent inscrits sur le moment.
--   2. Plus aucun pseudo d'analyste au journal (correction, statut d'analyste accordé ou retiré) : aucune personne
--      n'y est nommée. Les entrées passées ne changent pas (la chaîne d'empreintes l'interdit).
-- Limite : ce qui se voit sur le site (une vidéo qui disparaît ou paraît) reste observable sur le moment.

CREATE TABLE ledger.pending (
    id       bigserial PRIMARY KEY,
    due_at   timestamptz NOT NULL,
    kind     text NOT NULL,
    payload  jsonb NOT NULL
);
CREATE INDEX pending_due ON ledger.pending (due_at);
REVOKE ALL ON ledger.pending FROM PUBLIC;

-- Écriture immédiate dans la chaîne (l'ancien corps de ledger.append), réservée aux fonctions du journal.
CREATE FUNCTION ledger.write(p_kind text, p_payload jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, public
AS $$
DECLARE
    v_prev  bytea;
    v_time  timestamptz := clock_timestamp();
    v_seq   bigint;
BEGIN
    LOCK TABLE ledger.entries IN EXCLUSIVE MODE;
    SELECT hash INTO v_prev FROM ledger.entries ORDER BY seq DESC LIMIT 1;
    v_prev := coalesce(v_prev, '\x00'::bytea);
    INSERT INTO ledger.entries (recorded_at, kind, payload, prev_hash, hash)
    VALUES (v_time, p_kind, p_payload, v_prev,
            ledger.entry_hash(v_prev, p_kind, p_payload, v_time))
    RETURNING seq INTO v_seq;
    RETURN v_seq;
END
$$;
REVOKE ALL ON FUNCTION ledger.write(text, jsonb) FROM PUBLIC;

-- Seule porte d'entrée pour les appelants : retire le pseudo d'analyste, puis inscrit ou met en attente.
-- Renvoie le numéro de l'entrée, ou NULL si elle est différée.
CREATE OR REPLACE FUNCTION ledger.append(p_kind text, p_payload jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, public
AS $$
DECLARE
    v_payload jsonb := p_payload - 'analyst';
BEGIN
    IF p_kind IN ('withdrawal', 'original_shared', 'admin_action')
       OR (p_kind IN ('decision', 'removal') AND v_payload ->> 'stage' = 'legal') THEN
        INSERT INTO ledger.pending (due_at, kind, payload)
        VALUES (now() + random() * interval '24 hours', p_kind, v_payload);
        RETURN NULL;
    END IF;
    RETURN ledger.write(p_kind, v_payload);
END
$$;

-- Inscrit les entrées arrivées à échéance (toutes avec p_tout, pour les tests), dans l'ordre de leur échéance.
CREATE FUNCTION ledger.flush_pending(p_tout boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, public
AS $$
DECLARE
    r  record;
    n  integer := 0;
BEGIN
    FOR r IN SELECT id, kind, payload FROM ledger.pending WHERE p_tout OR due_at <= now()
              ORDER BY due_at, id FOR UPDATE SKIP LOCKED LOOP
        PERFORM ledger.write(r.kind, r.payload);
        DELETE FROM ledger.pending WHERE id = r.id;
        n := n + 1;
    END LOOP;
    RETURN n;
END
$$;
REVOKE ALL ON FUNCTION ledger.flush_pending(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.flush_pending(boolean) TO argos_scoring;
