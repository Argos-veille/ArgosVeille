// Rapports de bug (étape interface I-1).
//   GET  /bugs/themes    grands thèmes et thèmes précis proposés par le formulaire
//   POST /bugs           { theme, sousTheme, description, page, pageSource, telemetrie?, capture?, joindrePseudo }
// La télémétrie est prise par le navigateur au moment de l'envoi et montrée avant : le serveur ne
// fait que la ranger. Jamais d'adresse IP en base : la limite (5 rapports par heure) compte une
// empreinte de l'adresse dans Redis, effacée au bout d'une heure. Le pseudo n'est joint que si la
// personne le demande, et jamais depuis une page des sources (ni capture d'écran).
//   GET  /dev/boite      développement seulement : derniers SMS et mails du faux facteur local
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { empreinte } from './crypto.ts';
import { derniersEnvois } from './facteur.ts';
import { consommer } from './limites.ts';
import { texte, texteLong } from './schemas.ts';
import { lireSession } from './sessions.ts';

/** Grand thème → thèmes précis. `source: false` : masqué sur les pages des sources. */
export const THEMES = [
  { cle: 'compte', libelle: 'Compte et connexion', source: false, precis: {
    inscription: 'Inscription', sms_mail: 'SMS ou mail non reçu', connexion: 'Connexion impossible',
    application_2fa: 'Double authentification (application)', cle_securite: 'Clé de sécurité',
    codes_secours: 'Codes de secours', mot_de_passe: 'Mot de passe oublié', nouvel_appareil: 'Alerte nouvel appareil' } },
  { cle: 'envoi', libelle: "Envoi d'une vidéo", source: true, precis: {
    fichier_refuse: 'Fichier refusé', envoi_bloque: 'Envoi bloqué ou interrompu', reprise: "Reprise de l'envoi",
    preremplissage: 'Date et lieu mal préremplis', code_suivi: 'Code de suivi (création, perte)', lenteur: 'Trop lent' } },
  { cle: 'suivi', libelle: 'Suivi et floutage', source: true, precis: {
    code_refuse: 'Code de suivi refusé', floutage_incomplet: 'Floutage incomplet (visage visible)',
    floutage_en_trop: 'Floutage en trop', retouches: 'Retouches', retrait: 'Retrait de la vidéo' } },
  { cle: 'relecture', libelle: 'Relecture et jury', source: false, precis: {
    convocation: 'Convocation absente ou disparue', video_illisible: 'Vidéo illisible', vote_refuse: 'Vote refusé',
    raisons: 'Raisons proposées inadaptées', jury: 'Jury', mail_convocation: 'Mail de convocation' } },
  { cle: 'notes', libelle: "Notes d'analystes", source: true, precis: {
    ecrire: 'Écrire ou corriger une note', liens: 'Liens refusés', invisibles: 'Notes invisibles',
    jugement: 'Jugement des notes' } },
  { cle: 'public', libelle: 'Carte et fiches publiques', source: true, precis: {
    carte: 'Carte (affichage, lenteur)', fiche: "Fiche d'une vidéo", recherche: 'Recherche et filtres',
    journal: 'Journal public' } },
  { cle: 'affichage', libelle: 'Affichage et accessibilité', source: true, precis: {
    mise_en_page: 'Mise en page cassée', mobile: 'Téléphone ou tablette', theme: 'Mode clair ou sombre',
    accessibilite: 'Lecture d’écran, clavier', textes: 'Textes ou traductions' } },
  { cle: 'securite', libelle: 'Sécurité et confidentialité', source: true, urgent: true, precis: {
    suspect: 'Comportement suspect', donnee_visible: 'Donnée qui ne devrait pas apparaître', faille: 'Faille possible' } },
  { cle: 'autre', libelle: 'Autre', source: true, precis: {} },
] as const satisfies readonly { cle: string; libelle: string; source: boolean; urgent?: boolean; precis: Record<string, string> }[];

const PAR_CLE = new Map<string, (typeof THEMES)[number]>(THEMES.map((t) => [t.cle, t]));
const CAPTURE_MAX = 3 * 1024 * 1024;

interface Rapport {
  theme: string; sousTheme: string; description: string; page: string; pageSource: boolean;
  telemetrie?: Record<string, unknown>; capture?: string; joindrePseudo: boolean;
}

export function enregistrerBugs(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles } = deps;

  app.get('/bugs/themes', async (_req, reply) => reply.send({
    themes: THEMES.map((t) => ({
      cle: t.cle, libelle: t.libelle, pourLesSources: t.source, urgent: 'urgent' in t && t.urgent === true,
      precis: [...Object.entries(t.precis).map(([cle, libelle]) => ({ cle, libelle })), { cle: 'autre', libelle: 'Autre' }],
    })),
  }));

  app.post<{ Body: Rapport }>('/bugs', {
    bodyLimit: 5 * 1024 * 1024,   // capture d'écran comprise
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['theme', 'sousTheme', 'description', 'page', 'pageSource', 'joindrePseudo'],
        properties: {
          theme: { type: 'string', pattern: '^[a-z_]{1,40}$' },
          sousTheme: { type: 'string', pattern: '^[a-z_]{1,40}$' },
          description: texteLong(5000),
          page: texte(200),
          pageSource: { type: 'boolean' },
          telemetrie: { type: 'object', maxProperties: 40 },
          capture: { type: 'string', maxLength: Math.ceil(CAPTURE_MAX / 3) * 4 + 30, pattern: '^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$' },
          joindrePseudo: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const r = req.body;
    if (!r.description.trim()) return reply.code(400).send({ erreur: 'requete_invalide' });
    const theme = PAR_CLE.get(r.theme);
    if (!theme || (r.sousTheme !== 'autre' && !(r.sousTheme in theme.precis))) {
      return reply.code(400).send({ erreur: 'theme_inconnu' });
    }
    if (r.pageSource && (!theme.source || r.capture || r.joindrePseudo)) {
      return reply.code(400).send({ erreur: 'requete_invalide' });   // ni pseudo, ni capture depuis une page des sources
    }
    const telemetrie = r.telemetrie ? JSON.stringify(r.telemetrie) : null;
    if (telemetrie && Buffer.byteLength(telemetrie) > 200_000) return reply.code(413).send({ erreur: 'trop_volumineux' });
    const capture = r.capture ? Buffer.from(r.capture.slice(r.capture.indexOf(',') + 1), 'base64') : null;
    if (capture && capture.length > CAPTURE_MAX) return reply.code(413).send({ erreur: 'trop_volumineux' });
    if (!(await consommer(redis, `bug:ip:${empreinte(cles, 'ip', req.ip).toString('hex')}`, 5, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    const compte = r.joindrePseudo ? await lireSession(bases, req) : null;
    await bases.app.query(
      `INSERT INTO core.bug_reports (theme, subtheme, urgent, description, page, source_page, telemetry, screenshot, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.theme, r.sousTheme, 'urgent' in theme && theme.urgent === true, r.description.trim(), r.page, r.pageSource,
       telemetrie, capture, compte?.id ?? null]);
    return reply.code(201).send({ ok: true, requete: req.id });
  });

  if (deps.reglages.boiteDev) {
    const dossier = deps.reglages.boiteDev;
    app.get('/dev/boite', async (_req, reply) => reply.send(await derniersEnvois(dossier)));
  }
}
