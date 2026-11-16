// Relecture, côté relecteur connecté (étape 7a : convocations).
//   GET  /relecture                        convocations en attente, relectures des dernières 24 h
//   POST /relecture/:convocation/video     lien de visionnage (version floutée seulement), 10 minutes
//   POST /relecture/:convocation/passer    passer son tour, sans pénalité
//   POST /relecture/:convocation/vote      oui / en partie / non, avec des raisons (étape 7b)
// Les convocations au jury (étape 7c) passent par les mêmes routes : marquées « second examen »,
// sans aucun chiffre du premier tour ; le juré répond oui ou non, les raisons étant facultatives.
//   GET  /relecture/:convocation/notes     notes des analystes OSINT (7d), une fois la vidéo regardée
// Vote et notes attendent le premier visionnage : la vidéo ouverte, et la moitié de sa durée écoulée.
//   POST /compte/notifications             activer ou couper le mail de convocation
// Les convocations sont tirées au hasard par le moteur de relecture (src/moteur.ts, rôle à part) :
// le site ne fait que les montrer. Le relecteur ne voit jamais l'original, ni la source, ni les votes.
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { ecrire } from './compte.ts';
import { AVIS, contradictoires, contraires, correctionDe, ETATS, notesDeLaVideo, NOTES_INCOMPATIBLES, RAISONS_NOTES, RAPPEL_NOTES,
         TOUTES_RAISONS_NOTES } from './osint.ts';
import { codeArgos, listeChoix } from './schemas.ts';
import { creerLien } from './suivi.ts';

/** Raisons proposées, à la manière des notes de communauté : propres au « oui » et au « non » ;
 *  « en partie » propose les deux. Clé de l'API → code en base. */
export const RAISONS = {
  oui: {
    intervention_visible: ['intervention_visible', "L'intervention des forces de l'ordre est visible"],
    contexte_coherent: ['context_consistent', 'Le lieu et la date sont cohérents avec ce qui est annoncé'],
    authentique: ['authentic', 'La vidéo paraît authentique'],
    categorie_correcte: ['category_matches', 'La vidéo correspond à la catégorie annoncée'],
  },
  non: {
    mauvaise_categorie: ['wrong_category', 'La vidéo ne correspond pas à la catégorie annoncée'],
    ancienne_ou_reutilisee: ['old_or_reused', 'Vidéo ancienne, ou déjà publiée pour un autre événement'],
    montage_trompeur: ['misleading_edit', 'Montage trompeur, ou vidéo générée'],
    rien_de_visible: ['nothing_visible', "On ne voit pas ce qui est annoncé"],
    contexte_incoherent: ['context_inconsistent', 'Le lieu ou la date ne correspondent pas'],
  },
} as const;
const TOUTES = { ...RAISONS.oui, ...RAISONS.non } as Record<string, readonly [string, string]>;
/** Raisons qui se contredisent : jamais cochées ensemble (« en partie » propose les deux listes). */
export const VOTE_INCOMPATIBLES: readonly (readonly [string, string])[] = [
  ['intervention_visible', 'rien_de_visible'], ['contexte_coherent', 'contexte_incoherent'],
  ['contexte_coherent', 'ancienne_ou_reutilisee'], ['authentique', 'montage_trompeur'],
  ['categorie_correcte', 'mauvaise_categorie'],
];
/** Raisons envoyées à l'écran, chacune avec ses contraires. */
const avecContraires = (raisons: Record<string, readonly [string, string]>, paires: readonly (readonly [string, string])[]) =>
  Object.entries(raisons).map(([cle, [, libelle]]) => ({ cle, libelle, contraires: contraires(paires, cle) }));
const VERDICTS = { oui: 'valid', en_partie: 'partly', non: 'invalid' } as const;
/** Erreurs du déclencheur de vote (codes « argos:… ») → réponse de l'API. */
const ERREURS_VOTE: Record<string, [number, string]> = {
  sans_convocation: [404, 'introuvable'],
  convocation_terminee: [404, 'introuvable'],
  relecture_terminee: [409, 'relecture_terminee'],
  places_prises: [409, 'places_prises'],
  plafond_journalier: [429, 'plafond_journalier'],
  compte_inactif: [403, 'compte_inactif'],
  double_auth_requise: [403, 'double_auth_requise'],
};
/** Convocation valable seulement tant que la vidéo est à l'étape correspondante. */
const ETAPE_VALABLE = `((s.round = 'review' AND v.status = 'in_review')
                     OR (s.round = 'jury' AND v.status = 'jury' AND v.jury_started_at IS NOT NULL)
                     OR (s.round = 'control' AND core.control_active(v.id)))`;

const CONVOCATION = {
  type: 'object', additionalProperties: false, required: ['convocation'],
  properties: { convocation: { type: 'string', format: 'uuid' } },
} as const;

async function reglages(deps: Dependances): Promise<{ reviews_per_day: number }> {
  const r = await deps.bases.app.query<{ params: { reviews_per_day: number } }>(
    'SELECT params FROM core.settings ORDER BY version DESC LIMIT 1');
  return r.rows[0]!.params;
}

export function enregistrerRelecture(app: FastifyInstance, deps: Dependances): void {
  const { bases } = deps;
  const session = { preHandler: app.exigerSession };

  /** Convocation en attente, valable, du relecteur connecté, pour une vidéo encore en relecture. */
  async function convocation(compteId: string, id: string) {
    const r = await bases.app.query<{ video_id: string; round: 'review' | 'jury' | 'control' }>(
      `SELECT s.video_id, s.round FROM core.summons s JOIN core.videos v ON v.id = s.video_id
        WHERE s.id = $1 AND s.account_id = $2 AND s.outcome = 'pending'
          AND s.expires_at > now() AND ${ETAPE_VALABLE}`, [id, compteId]);
    return r.rows[0];
  }

  /** Visionnage : la vidéo doit avoir été ouverte, et la moitié de sa durée écoulée depuis (garde-fou
   *  du serveur ; l'écran attend, lui, 90 % de la vidéo réellement regardés). Renvoie les secondes à attendre,
   *  ou null si la vidéo n'a jamais été ouverte. */
  async function attenteVisionnage(convocationId: string): Promise<number | null> {
    const r = await bases.app.query<{ reste: number | null }>(
      `SELECT CASE WHEN s.video_opened_at IS NULL THEN NULL
                   ELSE greatest(0, ceil(extract(epoch FROM s.video_opened_at
                                    + make_interval(secs => coalesce(v.duration_s, 0) * 0.5) - now())))::int END AS reste
         FROM core.summons s JOIN core.videos v ON v.id = s.video_id WHERE s.id = $1`, [convocationId]);
    return r.rows[0]?.reste ?? null;
  }
  const pasEncoreVue = (reste: number | null) =>
    ({ erreur: 'video_pas_encore_vue', ...(reste !== null ? { disponibleDans: reste } : {}) });

  app.get('/relecture', session, async (req, reply) => {
    const id = req.compte!.id;
    const [liste, faites, compte, r, aJuger] = await Promise.all([
      bases.app.query<{
        id: string; round: 'review' | 'jury' | 'control'; expires_at: Date; pseudonym: string | null; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[];
        forces: string | null; situation: string | null; occurred_at: Date | null; location_precision: string | null;
        lat: number | null; lon: number | null; description: string | null; language: string | null; metadata_check: string | null;
        notes: number; occurred_time_known: boolean; video_id: string; origine: unknown;
        date_to_establish: boolean; location_to_establish: boolean;
      }>(
        `SELECT s.id, s.round, s.expires_at, CASE WHEN s.round = 'control' THEN ct.display_pseudonym ELSE p.pseudonym END AS pseudonym, v.id AS video_id, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations, v.occurred_at,
                v.location_precision, ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon,
                v.description, v.language, v.metadata_check, v.occurred_time_known, v.date_to_establish, v.location_to_establish,
                CASE WHEN s.round = 'control' THEN NULL ELSE (SELECT jsonb_build_object('publiePar', o.published_by, 'lien', o.url, 'precisions', o.details) FROM core.video_origins o WHERE o.video_id = v.id) END AS origine,
                (SELECT count(*)::int FROM core.osint_notes n
                  WHERE s.round <> 'control' AND n.video_id = v.id AND n.withdrawn_at IS NULL AND n.masked_at IS NULL) AS notes
           FROM core.summons s
           JOIN core.videos v ON v.id = s.video_id
           LEFT JOIN core.pseudonyms p ON p.video_id = v.id
           LEFT JOIN core.control_videos ct ON ct.video_id = v.id
          WHERE s.account_id = $1 AND s.outcome = 'pending' AND s.expires_at > now()
            AND ${ETAPE_VALABLE}
          ORDER BY s.expires_at`, [id]),
      bases.app.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM core.summons
          WHERE account_id = $1 AND outcome = 'voted' AND answered_at > now() - interval '24 hours'`, [id]),
      bases.app.query<{ notify_summons: boolean }>('SELECT notify_summons FROM core.accounts WHERE id = $1', [id]),
      reglages(deps),
      // Votes des 7 derniers jours sur des vidéos qui ont des notes d'analystes à juger.
      bases.app.query<{ id: string; notes: number; jugees: number }>(
        `SELECT s.id,
                (SELECT count(*)::int FROM core.osint_notes n WHERE n.video_id = s.video_id AND n.withdrawn_at IS NULL
                    AND n.masked_at IS NULL AND n.author_id IS DISTINCT FROM $1) AS notes,
                (SELECT count(*)::int FROM core.my_note_ratings($1, s.id)) AS jugees
           FROM core.summons s JOIN core.videos v ON v.id = s.video_id
          WHERE s.account_id = $1 AND s.round <> 'control' AND s.outcome = 'voted' AND s.answered_at > now() - interval '7 days'
            AND v.status NOT IN ('hidden', 'removed', 'withdrawn')
          ORDER BY s.answered_at DESC`, [id]),
    ]);
    // Correction en cours de la date, de l'heure ou du lieu (l'identifiant de la vidéo n'est pas montré).
    const corrections = await Promise.all(liste.rows.map((c) => (c.round === 'control' ? null : correctionDe(deps, c.video_id))));
    // Vidéo publiée qui ressemble (premier tour seulement) : jamais une vidéo non publiée.
    const ressemblances = await Promise.all(liste.rows.map(async (c) => (c.round === 'review'
      ? (await bases.app.query<{ id: string; pseudonym: string | null }>('SELECT * FROM core.reviewer_lookalike($1)', [c.video_id])).rows[0] ?? null
      : null)));
    const evenements = await Promise.all(liste.rows.map(async (c) => (c.round === 'review'
      ? (await bases.app.query<{ id: string; pseudonym: string | null }>('SELECT * FROM core.reviewer_event_candidates($1)', [c.video_id])).rows : [])));
    return reply.send({
      relecturesAujourdhui: faites.rows[0]!.n,
      plafondParJour: r.reviews_per_day,
      mailConvocations: compte.rows[0]?.notify_summons ?? true,
      notesAJuger: aJuger.rows.filter((x) => x.notes > x.jugees)
        .map((x) => ({ convocation: x.id, notes: x.notes, dejaJugees: x.jugees })),
      raisons: { oui: avecContraires(RAISONS.oui, VOTE_INCOMPATIBLES), non: avecContraires(RAISONS.non, VOTE_INCOMPATIBLES) },
      convocations: liste.rows.map((c, i) => ({
        correction: corrections[i],
        origine: c.origine,
        ressemblance: ressemblances[i] ? { video: ressemblances[i]!.id, pseudonyme: ressemblances[i]!.pseudonym } : null,
        evenements: evenements[i]!.map((x) => ({ video: x.id, pseudonyme: x.pseudonym })),
        convocation: c.id,
        secondExamen: c.round === 'jury',
        verdicts: c.round === 'jury' ? ['oui', 'non'] : Object.keys(VERDICTS),
        raisonsObligatoires: c.round !== 'jury',
        expireLe: c.expires_at.toISOString(),
        pseudonyme: c.pseudonym,
        categorie: c.category,
        sousCategorie: c.subcategory, sousCategories: listeChoix(c.subcategory, c.extra_subcategories),
        forces: c.forces,
        situation: c.situation, situations: listeChoix(c.situation, c.extra_situations),
        date: c.occurred_at?.toISOString() ?? null,
        heureConnue: c.occurred_time_known,
        aEtablir: { date: c.date_to_establish, lieu: c.location_to_establish },
        lieu: c.lat !== null && c.lon !== null ? { lat: c.lat, lon: c.lon, precision: c.location_precision } : null,
        description: c.description,
        langue: c.language,
        metadonnees: c.metadata_check,
        notesAnalystes: c.notes,   // le nombre seulement : le contenu s'ouvre une fois la vidéo vue
      })),
    });
  });

  app.post<{ Params: { convocation: string }; Body: { qualite?: 'apercu' | 'complete' } }>('/relecture/:convocation/video', {
    ...session,
    schema: {
      params: CONVOCATION,
      body: { type: 'object', additionalProperties: false, properties: { qualite: { type: 'string', enum: ['apercu', 'complete'] } } },
    },
  }, async (req, reply) => {
    const c = await convocation(req.compte!.id, req.params.convocation);
    if (!c) return reply.code(404).send({ erreur: 'introuvable' });
    const lien = await creerLien(deps, c.video_id, req.body.qualite ?? 'complete');
    await bases.app.query('UPDATE core.summons SET video_opened_at = now() WHERE id = $1 AND video_opened_at IS NULL',
      [req.params.convocation]);
    return reply.send(lien);
  });

  // Première impression seul : les notes ne s'ouvrent qu'après avoir ouvert la vidéo. Après son
  // vote, le relecteur les retrouve (même si la relecture est close) pour les juger, avec leur état.
  app.get<{ Params: { convocation: string } }>('/relecture/:convocation/notes', {
    ...session, schema: { params: CONVOCATION },
  }, async (req, reply) => {
    const r = await bases.app.query<{ video_id: string; round: string; outcome: string; ouverte: boolean; valable: boolean }>(
      `SELECT s.video_id, s.round, s.outcome, s.video_opened_at IS NOT NULL AS ouverte,
              (s.outcome = 'pending' AND s.expires_at > now() AND ${ETAPE_VALABLE}) AS valable
         FROM core.summons s JOIN core.videos v ON v.id = s.video_id
        WHERE s.id = $1 AND s.account_id = $2 AND v.status NOT IN ('hidden', 'removed', 'withdrawn')`,
      [req.params.convocation, req.compte!.id]);
    const c = r.rows[0];
    if (!c || (c.outcome !== 'voted' && !c.valable)) return reply.code(404).send({ erreur: 'introuvable' });
    if (c.outcome === 'voted') {
      return reply.send({
        rappel: RAPPEL_NOTES,
        raisons: { oui: avecContraires(RAISONS_NOTES.oui, NOTES_INCOMPATIBLES), non: avecContraires(RAISONS_NOTES.non, NOTES_INCOMPATIBLES) },
        notes: c.round === 'control' ? [] : await notesDeLaVideo(deps, c.video_id, undefined,
          { etat: true, juge: { compte: req.compte!.id, convocation: req.params.convocation } }),
      });
    }
    const reste = await attenteVisionnage(req.params.convocation);
    if (reste === null || reste > 0) return reply.code(409).send(pasEncoreVue(reste));
    return reply.send({ rappel: RAPPEL_NOTES, notes: c.round === 'control' ? [] : await notesDeLaVideo(deps, c.video_id) });
  });

  app.post<{ Params: { convocation: string; note: string };
              Body: { avis: keyof typeof AVIS; raisons: string[] } }>('/relecture/:convocation/notes/:note/jugement', {
    ...session,
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['convocation', 'note'],
                properties: { convocation: { type: 'string', format: 'uuid' }, note: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false, required: ['avis', 'raisons'],
        properties: {
          avis: { type: 'string', enum: Object.keys(AVIS) },
          raisons: { type: 'array', minItems: 1, maxItems: 9, uniqueItems: true,
                     items: { type: 'string', enum: Object.keys(TOUTES_RAISONS_NOTES) } },
        },
      },
    },
  }, async (req, reply) => {
    const { avis, raisons } = req.body;
    const permises: readonly string[] = avis === 'oui' ? Object.keys(RAISONS_NOTES.oui)
      : avis === 'non' ? Object.keys(RAISONS_NOTES.non) : Object.keys(TOUTES_RAISONS_NOTES);
    if (raisons.some((x) => !permises.includes(x))) return reply.code(400).send({ erreur: 'raisons_invalides' });
    if (contradictoires(NOTES_INCOMPATIBLES, raisons)) return reply.code(400).send({ erreur: 'raisons_contradictoires' });
    try {
      const r = await bases.app.query<{ etat: keyof typeof ETATS }>(
        'SELECT core.rate_note($1, $2, $3, $4, $5) AS etat',
        [req.compte!.id, req.params.convocation, req.params.note, AVIS[avis], raisons.map((x) => TOUTES_RAISONS_NOTES[x]![0])]);
      return reply.send({ ok: true, etat: ETATS[r.rows[0]!.etat] });
    } catch (e) {
      const code = codeArgos(e);
      if (code === 'sans_vote' || code === 'note_introuvable') return reply.code(404).send({ erreur: 'introuvable' });
      if (code === 'propre_note') return reply.code(409).send({ erreur: 'propre_note' });
      throw e;
    }
  });

  app.post<{ Params: { convocation: string } }>('/relecture/:convocation/passer', {
    ...session, schema: { params: CONVOCATION },
  }, async (req, reply) => {
    const r = await bases.app.query(
      `UPDATE core.summons SET outcome = 'passed', answered_at = now()
        WHERE id = $1 AND account_id = $2 AND outcome = 'pending' AND expires_at > now()`,
      [req.params.convocation, req.compte!.id]);
    if (!r.rowCount) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { convocation: string };
              Body: { verdict: keyof typeof VERDICTS; raisons: string[]; visageIdentifiable: boolean; dejaPresente?: string;
                     evenements?: { fiche: string; oui: boolean }[]; memeEvenement?: string } }>('/relecture/:convocation/vote', {
    ...session,
    schema: {
      params: CONVOCATION,
      body: {
        type: 'object', additionalProperties: false, required: ['verdict', 'raisons', 'visageIdentifiable'],
        properties: {
          verdict: { type: 'string', enum: Object.keys(VERDICTS) },
          raisons: { type: 'array', minItems: 0, maxItems: 9, uniqueItems: true, items: { type: 'string', enum: Object.keys(TOUTES) } },
          visageIdentifiable: { type: 'boolean' },
          dejaPresente: { type: 'string', minLength: 1, maxLength: 300 },   // lien, identifiant ou nom de la fiche
          // Même événement : réponses aux fiches proposées (absente = je ne sais pas), et fiche indiquée par le relecteur.
          evenements: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['fiche', 'oui'],
                                                              properties: { fiche: { type: 'string', format: 'uuid' }, oui: { type: 'boolean' } } } },
          memeEvenement: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  }, async (req, reply) => {
    const { verdict, raisons, visageIdentifiable, dejaPresente, evenements, memeEvenement } = req.body;
    const permises: readonly string[] = verdict === 'oui' ? Object.keys(RAISONS.oui)
      : verdict === 'non' ? Object.keys(RAISONS.non) : Object.keys(TOUTES);
    if (raisons.some((r) => !permises.includes(r))) return reply.code(400).send({ erreur: 'raisons_invalides' });
    if (contradictoires(VOTE_INCOMPATIBLES, raisons)) return reply.code(400).send({ erreur: 'raisons_contradictoires' });
    const c = await convocation(req.compte!.id, req.params.convocation);
    if (!c) return reply.code(404).send({ erreur: 'introuvable' });
    // Premier tour : au moins une raison. Jury : oui ou non, raisons facultatives.
    if (c.round !== 'jury' && raisons.length === 0) return reply.code(400).send({ erreur: 'raisons_invalides' });
    if (c.round === 'jury' && verdict === 'en_partie') return reply.code(400).send({ erreur: 'verdict_invalide' });
    const reste = await attenteVisionnage(req.params.convocation);
    if (reste === null || reste > 0) return reply.code(409).send(pasEncoreVue(reste));
    let doublonDe: string | null = null;
    const controle = c.round === 'control';   // réponses ignorées sans le dire : la vidéo ne doit pas se trahir
    if (dejaPresente !== undefined && !controle) {   // réponse du premier tour seulement, indépendante du verdict
      if (c.round === 'jury') return reply.code(400).send({ erreur: 'fiche_introuvable' });
      doublonDe = (await bases.app.query<{ v: string | null }>('SELECT core.resolve_published($1) AS v', [dejaPresente])).rows[0]!.v;
      if (!doublonDe || doublonDe === c.video_id) return reply.code(400).send({ erreur: 'fiche_introuvable' });
    }
    const reponsesEvenement = controle ? [] : [...(evenements ?? [])];
    if (c.round === 'jury' && (reponsesEvenement.length || memeEvenement !== undefined)) return reply.code(400).send({ erreur: 'fiche_introuvable' });
    if (memeEvenement !== undefined && !controle) {
      const fiche = (await bases.app.query<{ v: string | null }>('SELECT core.resolve_published($1) AS v', [memeEvenement])).rows[0]!.v;
      if (!fiche || fiche === c.video_id) return reply.code(400).send({ erreur: 'fiche_introuvable' });
      reponsesEvenement.push({ fiche, oui: true });
    }
    try {
      // Le poids est calculé par la base ; le site n'en fournit qu'une valeur de remplissage.
      await bases.app.query(
        `INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight, duplicate_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
        [req.params.convocation, c.video_id, req.compte!.id, c.round, VERDICTS[verdict], raisons.map((r) => TOUTES[r]![0]),
         { face_identifiable: visageIdentifiable }, doublonDe]);
    } catch (e) {
      const code = /argos:([a-z_]+)/.exec(String((e as Error).message))?.[1];
      const r = code ? ERREURS_VOTE[code] : undefined;
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      throw e;
    }
    if (reponsesEvenement.length) {
      await bases.app.query('SELECT core.record_event_answers($1, $2, $3)', [req.compte!.id, req.params.convocation, JSON.stringify(reponsesEvenement)]);
    }
    return reply.send({ ok: true });
  });

  // Préférences de mails : convocations, et avancement des vidéos envoyées avec le compte
  // (« floutage prêt » n'est pas désactivable).
  const PREFS = { convocations: 'notify_summons', relecture: 'notify_owner_review', decision: 'notify_owner_decision',
                  motifLegal: 'notify_owner_legal', messageVideo: 'notify_owner_message', reponseSource: 'notify_source_replies' } as const;
  const lirePrefs = async (id: string) => {
    const r = await bases.app.query<Record<string, boolean>>(
      `SELECT ${Object.values(PREFS).join(', ')} FROM core.accounts WHERE id = $1`, [id]);
    return Object.fromEntries(Object.entries(PREFS).map(([cle, col]) => [cle, r.rows[0]![col]]));
  };
  app.get('/compte/notifications', session, async (req, reply) => reply.send(await lirePrefs(req.compte!.id)));
  app.post<{ Body: Partial<Record<keyof typeof PREFS, boolean>> }>('/compte/notifications', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1,
                      properties: Object.fromEntries(Object.keys(PREFS).map((k) => [k, { type: 'boolean' }])) } },
  }, async (req, reply) => {
    const champs = Object.entries(req.body) as [keyof typeof PREFS, boolean][];
    await bases.app.query(
      `UPDATE core.accounts SET ${champs.map(([k], i) => `${PREFS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [req.compte!.id, ...champs.map(([, v]) => v)]);
    const prefs = await lirePrefs(req.compte!.id);
    return reply.send({ ...prefs, mailConvocations: prefs['convocations'] });
  });
}

/** Tâche horaire : un mail sobre aux relecteurs qui ont de nouvelles convocations, au plus un par
 *  jour et par compte, sans rien dire de la vidéo. */
export async function prevenirConvocations(deps: Dependances, seulement?: string[]): Promise<number> {
  // « seulement » : limite l'envoi à ces comptes (tests : ne pas dépendre des autres comptes de la base).
  const r = await deps.bases.app.query<{ id: string }>(
    `UPDATE core.accounts a SET summons_notified_at = now()
      WHERE a.notify_summons AND a.status = 'active' AND ($1::uuid[] IS NULL OR a.id = ANY($1))
        AND (a.summons_notified_at IS NULL OR a.summons_notified_at < now() - interval '24 hours')
        AND EXISTS (SELECT 1 FROM core.summons s
                     WHERE s.account_id = a.id AND s.outcome = 'pending' AND s.expires_at > now()
                       AND s.sent_at > coalesce(a.summons_notified_at, '-infinity'))
      RETURNING a.id`, [seulement ?? null]);
  let n = 0;
  for (const { id } of r.rows) {
    const ok = await ecrire(deps, id, 'une vidéo attend votre relecture',
      `Bonjour,\n\nUne ou plusieurs vidéos attendent votre relecture sur Argos Veille. Vous pouvez les voir, `
      + `ou passer votre tour sans pénalité :\n${deps.reglages.urlPublique}/relecture\n\n`
      + `Vous pouvez couper ces mails dans votre compte.`).catch(() => false);
    if (ok) n++;
  }
  return n;
}
