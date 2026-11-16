// Journal public et anonymat (0091) : actions de la source et de l'administration inscrites en différé
// (dans les 24 heures), plus aucun pseudo d'analyste.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { proprietaire } from './aide.ts';

// Sans passer par proprietaire() pour la lecture des entrées en attente (elle les inscrirait toutes).
const enAttente = (v: string) => proprietaire(
  `SELECT count(*) || '|' || coalesce(bool_and(due_at > now() AND due_at <= now() + interval '24 hours'), true) || '|'
          || coalesce(bool_or(payload ? 'analyst'), false) FROM ledger.pending WHERE payload ->> 'video' = '${v}'`);

test('différé : source et administration en attente, relecture et jury tout de suite, pseudo retiré', () => {
  const v = randomUUID();
  proprietaire(`SELECT ledger.append('admin_action', '{"action": "reblur", "video": "${v}", "analyst": "x"}'),
                       ledger.append('withdrawal', '{"video": "${v}"}'),
                       ledger.append('original_shared', '{"video": "${v}", "recipient": "lawyer"}'),
                       ledger.append('removal', '{"video": "${v}", "status": "removed", "stage": "legal"}'),
                       ledger.append('decision', '{"video": "${v}", "status": "published", "stage": "admin"}'),
                       ledger.append('decision', '{"video": "${v}", "status": "published", "stage": "review"}'),
                       ledger.append('correction', '{"video": "${v}", "analyst": "pseudo_analyste"}')`);
  assert.equal(enAttente(v), '5|true|false');
  // Les deux autres (relecture, correction) sont déjà au journal : lecture sans inscrire les entrées en attente.
  assert.equal(proprietaire(`SELECT string_agg(kind, ',' ORDER BY kind) FROM ledger."entries" WHERE payload ->> 'video' = '${v}'`),
               'correction,decision');
});

test('différé : le moteur inscrit seulement les entrées arrivées à échéance, chaîne intacte', () => {
  const v = randomUUID();
  proprietaire(`SELECT ledger.append('admin_action', '{"action": "a", "video": "${v}"}'),
                       ledger.append('admin_action', '{"action": "b", "video": "${v}"}')`);
  proprietaire(`UPDATE ledger.pending SET due_at = now() - interval '1 minute'
                 WHERE id = (SELECT min(id) FROM ledger.pending WHERE payload ->> 'video' = '${v}')`);
  // flush_pending() sans « tout » : seulement l'entrée échue. (Les entrées d'autres tests encore en attente
  // peuvent être inscrites aussi si elles sont échues, d'où le filtre par vidéo.)
  proprietaire('SELECT ledger.flush_pending()');
  assert.equal(enAttente(v).split('|')[0], '1');
  assert.equal(proprietaire(`SELECT string_agg(payload ->> 'action', ',') FROM ledger.entries WHERE payload ->> 'video' = '${v}'`), 'a,b');
  // Chaînées comme les autres (la base de test garde une rupture ancienne : on vérifie seulement ces entrées).
  assert.equal(proprietaire(`SELECT bool_and(e.hash = ledger.entry_hash(e.prev_hash, e.kind, e.payload, e.recorded_at)
                                             AND e.prev_hash = (SELECT p.hash FROM ledger.entries p WHERE p.seq = e.seq - 1))
                               FROM ledger.entries e WHERE e.payload ->> 'video' = '${v}'`), 't');
  // Correction : inscrite sans le pseudo de l'analyste.
  proprietaire(`SELECT ledger.append('correction', '{"video": "${v}", "analyst": "pseudo_analyste"}')`);
  assert.equal(proprietaire(`SELECT payload ? 'analyst' FROM ledger.entries WHERE kind = 'correction' AND payload ->> 'video' = '${v}'`), 'f');
});
