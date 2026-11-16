-- Journal public infalsifiable : chaque ligne contient l'empreinte de la précédente.
-- Aucune donnée personnelle dans payload (ni compte, ni pseudonyme, ni IP).

CREATE TABLE ledger.entries (
    seq         bigserial PRIMARY KEY,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    kind        text NOT NULL CHECK (kind IN (
                    'video_received', 'decision', 'removal', 'rule_change', 'authority_request',
                    'admin_action', 'event_link')),
    payload     jsonb NOT NULL,
    prev_hash   bytea NOT NULL,
    hash        bytea NOT NULL UNIQUE
);

-- Racine quotidienne publiée et ancrée dans Bitcoin via OpenTimestamps.
CREATE TABLE ledger.anchors (
    day          date PRIMARY KEY,
    last_seq     bigint NOT NULL REFERENCES ledger.entries (seq),
    root_hash    bytea NOT NULL,
    ots_proof    bytea,
    published_at timestamptz NOT NULL DEFAULT now()
);

-- Empreinte d'une ligne, indépendante du fuseau horaire de la session (horodatage figé en UTC).
CREATE FUNCTION ledger.entry_hash(p_prev bytea, p_kind text, p_payload jsonb, p_time timestamptz)
RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path = ledger, public
AS $$
    SELECT digest(p_prev || convert_to(
        p_kind || '|' || p_payload::text || '|'
        || to_char(p_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8'), 'sha256')
$$;

-- Seule façon d'écrire au journal : calcule l'empreinte en chaîne.
-- Le verrou garantit qu'aucune autre écriture ne s'intercale entre la lecture et l'insertion.
CREATE FUNCTION ledger.append(p_kind text, p_payload jsonb) RETURNS bigint
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

-- Vérifie toute la chaîne ; renvoie le premier numéro de ligne incohérent, ou NULL si tout est intact.
CREATE FUNCTION ledger.verify() RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path = ledger, public
AS $$
DECLARE
    r       record;
    v_prev  bytea := '\x00'::bytea;
BEGIN
    FOR r IN SELECT * FROM ledger.entries ORDER BY seq LOOP
        IF r.prev_hash <> v_prev
           OR r.hash <> ledger.entry_hash(r.prev_hash, r.kind, r.payload, r.recorded_at) THEN
            RETURN r.seq;
        END IF;
        v_prev := r.hash;
    END LOOP;
    RETURN NULL;
END
$$;

-- Ni modification ni suppression, même par le propriétaire de la table.
CREATE FUNCTION ledger.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'le journal public est en ajout seul';
END
$$;
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger.entries
    FOR EACH ROW EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger.entries
    FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_change();
