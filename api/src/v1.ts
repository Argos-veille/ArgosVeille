// API publique v1 : lecture seule, sans compte ni clé, ouverte aux autres sites (CORS), limitée par connexion.
// Données sous licence CC BY 4.0 : citer Argos Veille, faire un lien vers la fiche et garder la mention
// « faits allégués, non jugés ». Exactement ce que montre la fiche publique (lieu et heure arrondis).
//   GET /v1/videos                 vidéos publiées (et en débat avec etat=en_debat), 100 par page
//   GET /v1/videos/:id             une fiche, avec le code d'intégration
//   GET /v1/export.json | .csv     toutes les vidéos publiées et en débat
//   GET /v1/statistiques           comptes des vidéos publiées (par mois, nature, forces, situation)
//   GET /v1/transparence           rapport de transparence d'un trimestre terminé (petits nombres masqués)
//   GET /v1/oembed?url=…           intégration automatique (WordPress, Mastodon…) : https://oembed.com
// Une vidéo masquée ou retirée disparaît de l'API et des intégrations dès la décision.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { listeChoix } from './schemas.ts';
import type { Dependances } from './app.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { fichePublique, jourDe } from './public.ts';
import { PERIODES_STATS, statistiques } from './statistiques.ts';
import { TRIMESTRE, transparence } from './transparence.ts';

export const LICENCE = {
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/deed.fr',
  attribution: 'Argos Veille (argos-veille.fr) — citer la source et faire un lien vers la fiche de chaque vidéo',
  avertissement: 'Faits allégués, non jugés : chaque vidéo a été relue par la communauté, mais rien ne vaut décision de justice.',
} as const;
const ID = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const JOUR = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const PAGE = 100;

interface Ligne {
  id: string; status: string; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[]; forces: string | null; situation: string | null;
  heure: string | null; jour: string | null; occurred_time_known: boolean; lat: number | null; lon: number | null;
  location_precision: string | null; decided_at: Date | null;
}

export function enregistrerV1(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles } = deps;
  const site = deps.reglages.urlPublique;
  const limiter = (ip: string, quoi: string, n: number) => consommer(redis, `v1-${quoi}:ip:${empreinte(cles, 'ip', ip).toString('hex')}`, n, 3600);
  const trop = (reply: FastifyReply) => reply.code(429).send({ erreur: 'trop_de_demandes', ...LICENCE });

  /** Code d'intégration d'une vidéo (lecteur sans cookie ni traceur, lecture sur clic). */
  const integration = (id: string, largeur = 640) => {
    const hauteur = Math.round((largeur * 9) / 16) + 96;
    return {
      url: `${site}/integrer/${id}`, largeur, hauteur,
      html: `<iframe src="${site}/integrer/${id}" width="${largeur}" height="${hauteur}" style="border:0;max-width:100%" `
        + `title="Vidéo Argos Veille" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`,
    };
  };
  const enLigne = (v: Ligne) => ({
    id: v.id, fiche: `${site}/videos/${v.id}`, etat: v.status === 'published' ? 'publiee' : 'en_debat',
    categorie: v.category, sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories), forces: v.forces, situation: v.situation, situations: listeChoix(v.situation, v.extra_situations),
    date: v.occurred_time_known ? v.heure : v.jour, heureConnue: v.occurred_time_known,
    lieu: v.lat !== null && v.lon !== null ? { lat: v.lat, lon: v.lon, precision: v.location_precision } : null,
    decideeLe: jourDe(v.decided_at),
  });
  const CHAMPS = `v.id, v.status, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations, v.occurred_time_known, v.location_precision,
                  to_char(date_trunc('hour', v.occurred_at AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD"T"HH24:00') AS heure,
                  to_char(v.occurred_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
                  ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon, v.decided_at`;

  app.register(async (v1) => {
    // Lisible depuis n'importe quel site, sans cookie.
    v1.addHook('onSend', async (_req, reply, charge) => {
      reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'GET')
        .header('cross-origin-resource-policy', 'cross-origin');
      return charge;
    });

    v1.get<{ Querystring: { etat?: string; categorie?: string; forces?: string; du?: string; au?: string; apres?: string } }>('/videos', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        etat: { enum: ['publiee', 'en_debat'] }, categorie: { enum: ['violence', 'abuse'] },
        forces: { enum: ['national_police', 'gendarmerie', 'municipal_police', 'customs', 'unknown'] }, du: JOUR, au: JOUR,
        apres: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } } },
    }, async (req, reply) => {
      if (!(await limiter(req.ip, 'liste', 600))) return trop(reply);
      const q = req.query;
      // Pagination par curseur : jour de décision le plus récent d'abord, puis identifiant (jamais l'heure exacte de la
      // décision, audit M3) ; « apres » = dernier id reçu, lu seulement parmi les vidéos publiques de ce même état.
      const r = await bases.app.query<Ligne>(
        `SELECT ${CHAMPS} FROM core.videos v
          WHERE v.status = $1 AND NOT v.is_control
            AND ($2::text IS NULL OR v.category = $2) AND ($3::text IS NULL OR v.forces = $3)
            AND ($4::date IS NULL OR v.occurred_at >= $4::date) AND ($5::date IS NULL OR v.occurred_at < $5::date + 1)
            AND ($6::uuid IS NULL OR (date_trunc('day', v.decided_at, 'Europe/Paris'), v.id)
                 < (SELECT date_trunc('day', c.decided_at, 'Europe/Paris'), c.id FROM core.videos c
                     WHERE c.id = $6 AND c.status = $1 AND NOT c.is_control))
          ORDER BY date_trunc('day', v.decided_at, 'Europe/Paris') DESC, v.id DESC LIMIT ${PAGE}`,
        [q.etat === 'en_debat' ? 'under_debate' : 'published', q.categorie ?? null, q.forces ?? null, q.du ?? null, q.au ?? null,
         q.apres ?? null]);
      return reply.send({ ...LICENCE, videos: r.rows.map(enLigne), suivante: r.rows.length === PAGE ? r.rows.at(-1)!.id : null });
    });

    v1.get<{ Params: { id: string } }>('/videos/:id', { schema: { params: ID } }, async (req, reply) => {
      if (!(await limiter(req.ip, 'fiche', 600))) return trop(reply);
      const f = await fichePublique(deps, req.params.id);
      if (f.etat === 'ok') return reply.send({ ...LICENCE, ...f.fiche, fiche: `${site}/videos/${f.fiche.id}`, integration: integration(f.fiche.id) });
      if (f.etat === 'introuvable') return reply.code(404).send({ erreur: 'introuvable', ...LICENCE });
      return reply.code(410).send({ erreur: f.etat === 'masquee' ? 'video_masquee' : 'video_retiree', ...LICENCE });
    });

    const tout = async () => (await bases.app.query<Ligne>(
      `SELECT ${CHAMPS} FROM core.videos v WHERE v.status IN ('published', 'under_debate') AND NOT v.is_control
         AND NOT (v.status = 'published' AND EXISTS (SELECT 1 FROM core.videos m WHERE m.id = v.duplicate_of AND m.status = 'published'))
        ORDER BY v.decided_at DESC, v.id DESC LIMIT 100000`)).rows.map(enLigne);

    v1.get('/export.json', async (req, reply) => {
      if (!(await limiter(req.ip, 'export', 30))) return trop(reply);
      return reply.header('content-disposition', 'attachment; filename="argos-veille-videos.json"')
        .send({ ...LICENCE, exporteLe: new Date().toISOString(), videos: await tout() });
    });

    v1.get('/export.csv', async (req, reply) => {
      if (!(await limiter(req.ip, 'export', 30))) return trop(reply);
      const champ = (x: unknown) => {
        if (typeof x === 'number' || typeof x === 'boolean') return String(x);
        const t = x === null || x === undefined ? '' : String(x);
        // Guillemets doublés ; pas de formule exécutée par un tableur (=, +, -, @ en tête).
        return /[",\n\r]|^[=+\-@]/.test(t) ? `"${t.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : t;
      };
      const entete = ['id', 'fiche', 'etat', 'categorie', 'sous_categorie', 'forces', 'situation', 'date', 'heure_connue',
                      'latitude', 'longitude', 'precision_lieu', 'decidee_le', 'sous_categories', 'situations'];
      const lignes = (await tout()).map((v) => [v.id, v.fiche, v.etat, v.categorie, v.sousCategorie, v.forces, v.situation, v.date,
                                                v.heureConnue, v.lieu?.lat, v.lieu?.lon, v.lieu?.precision, v.decideeLe,
                                                v.sousCategories.join(';'), v.situations.join(';')].map(champ).join(','));
      const notice = `# ${LICENCE.licence} — ${LICENCE.attribution}. ${LICENCE.avertissement}`;
      return reply.header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="argos-veille-videos.csv"')
        .send([notice, entete.join(','), ...lignes].join('\r\n') + '\r\n');
    });

    v1.get<{ Querystring: { periode?: string; du?: string; au?: string } }>('/statistiques', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        periode: { enum: Object.keys(PERIODES_STATS) }, du: JOUR, au: JOUR } } },
    }, async (req, reply) => {
      if (!(await limiter(req.ip, 'statistiques', 600))) return trop(reply);
      return reply.send({ ...LICENCE, ...(await statistiques(deps, req.query)) });
    });

    v1.get<{ Querystring: { trimestre?: string } }>('/transparence', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { trimestre: { type: 'string', pattern: TRIMESTRE } } } },
    }, async (req, reply) => {
      if (!(await limiter(req.ip, 'transparence', 600))) return trop(reply);
      const r = await transparence(deps, req.query.trimestre);
      return r ? reply.send({ ...LICENCE, ...r }) : reply.code(404).send({ erreur: 'introuvable', ...LICENCE });
    });

    // oEmbed : à partir du lien d'une fiche, le code d'intégration.
    v1.get<{ Querystring: { url: string; format?: string; maxwidth?: string; maxheight?: string } }>('/oembed', {
      schema: { querystring: { type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', maxLength: 300 }, format: { enum: ['json'] },
        maxwidth: { type: 'string', pattern: '^[0-9]{2,4}$' }, maxheight: { type: 'string', pattern: '^[0-9]{2,4}$' } } } },
    }, async (req, reply) => {
      if (!(await limiter(req.ip, 'oembed', 600))) return trop(reply);
      const m = /\/videos\/([0-9a-f-]{36})\/?$/.exec(req.query.url);
      if (!m || !req.query.url.startsWith(`${site}/`)) return reply.code(404).send({ erreur: 'introuvable' });
      const f = await fichePublique(deps, m[1]!);
      if (f.etat !== 'ok') return reply.code(404).send({ erreur: 'introuvable' });
      let largeur = Math.min(Number(req.query.maxwidth ?? 640), 1280);
      if (req.query.maxheight) largeur = Math.min(largeur, Math.floor(((Number(req.query.maxheight) - 96) * 16) / 9));
      const i = integration(f.fiche.id, Math.max(240, largeur));
      return reply.send({
        version: '1.0', type: 'video', provider_name: 'Argos Veille', provider_url: site,
        title: 'Vidéo Argos Veille — faits allégués, non jugés', width: i.largeur, height: i.hauteur, html: i.html,
        license: LICENCE.licence, license_url: LICENCE.licenceUrl,
      });
    });
  }, { prefix: '/v1' });
}
