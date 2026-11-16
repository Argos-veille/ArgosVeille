-- Correctif de 0091 (14 novembre 2026) : les décisions du super-administrateur sur une vidéo ont l'étape « admin »
-- (et non seulement « legal ») ; elles étaient donc encore inscrites au journal à l'heure exacte. Elles sont désormais
-- différées comme les autres actions de l'administration.
CREATE OR REPLACE FUNCTION ledger.append(p_kind text, p_payload jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, public
AS $$
DECLARE
    v_payload jsonb := p_payload - 'analyst';
BEGIN
    IF p_kind IN ('withdrawal', 'original_shared', 'admin_action')
       OR (p_kind IN ('decision', 'removal') AND v_payload ->> 'stage' IN ('legal', 'admin')) THEN
        INSERT INTO ledger.pending (due_at, kind, payload)
        VALUES (now() + random() * interval '24 hours', p_kind, v_payload);
        RETURN NULL;
    END IF;
    RETURN ledger.write(p_kind, v_payload);
END
$$;
