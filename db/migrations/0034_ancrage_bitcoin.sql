-- Ancrage quotidien du journal public dans Bitcoin via OpenTimestamps (5 novembre 2026).
--
-- Une fois par jour, le worker envoie l'empreinte de la dernière entrée du journal (la « tête de
-- chaîne », qui engage toutes les précédentes) à des serveurs publics OpenTimestamps, et garde la
-- preuve. Quelques heures plus tard, la preuve est complétée : elle désigne le bloc Bitcoin qui fige
-- l'état du journal à cette date. Seule une empreinte quitte le serveur.
-- En développement, l'ancrage est simulé (aucun envoi) : simulated = true.

ALTER TABLE ledger.anchors
    ADD COLUMN bitcoin_block integer CHECK (bitcoin_block > 0),   -- bloc qui confirme la preuve
    ADD COLUMN upgraded_at   timestamptz,                         -- preuve complétée
    ADD COLUMN simulated     boolean NOT NULL DEFAULT false;

-- Une ancre n'est jamais effacée ; seule sa preuve se complète (une fois).
CREATE FUNCTION ledger.guard_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'une ancre du journal ne s''efface pas';
    END IF;
    IF NEW.day <> OLD.day OR NEW.last_seq <> OLD.last_seq OR NEW.root_hash <> OLD.root_hash
       OR NEW.simulated <> OLD.simulated OR NEW.published_at <> OLD.published_at
       OR OLD.bitcoin_block IS NOT NULL THEN
        RAISE EXCEPTION 'une ancre du journal ne change pas ; seule une preuve en attente se complète';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER anchors_guard BEFORE UPDATE OR DELETE ON ledger.anchors
    FOR EACH ROW EXECUTE FUNCTION ledger.guard_anchor();
REVOKE ALL ON FUNCTION ledger.guard_anchor() FROM PUBLIC;

GRANT SELECT (seq, hash, recorded_at) ON ledger.entries TO argos_worker;
GRANT SELECT, INSERT ON ledger.anchors TO argos_worker;
GRANT UPDATE (ots_proof, bitcoin_block, upgraded_at) ON ledger.anchors TO argos_worker;
