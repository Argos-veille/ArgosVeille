// Recherche d'adresse sur les cartes : POST /adresse { q } ; adresse la plus proche d'un lieu : POST /adresse/inverse { lat, lon }. Passe par notre serveur pour que le service d'adresses de l'État
// ne voie jamais l'adresse IP du visiteur. Le texte cherché n'est ni conservé ni journalisé (corps de requête, jamais l'URL).
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';

const SERVICE = 'https://data.geopf.fr/geocodage/search';
const SERVICE_INVERSE = 'https://data.geopf.fr/geocodage/reverse';

export interface AdresseProche { label: string; commune: string; codePostal: string; distance: number }

// Les mêmes lieux reviennent souvent (fiche publique, relecture) : réponses gardées en mémoire, jamais sur disque, une heure.
// Point bas de la revue (15 novembre 2026) : la mémoire est propre à chaque visiteur (clé = empreinte de son adresse IP
// et du point, jamais les coordonnées en clair) et la limite passe AVANT elle. Sinon, un temps de réponse plus court
// révélerait qu'une autre personne a déjà cherché ce point précis (une source qui place le lieu de sa vidéo, par exemple).
const memoire = new Map<string, { adresse: AdresseProche | null; expire: number }>();
const MEMOIRE_MAX = 2000;
const MEMOIRE_DUREE_MS = 3_600_000;

export function enregistrerAdresse(app: FastifyInstance, deps: Dependances): void {
  const { cles, redis } = deps;
  app.post<{ Body: { q: string } }>('/adresse', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string', minLength: 3, maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!(await consommer(redis, `adresse:ip:${empreinte(cles, 'ip', req.ip).toString('hex')}`, 60, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    try {
      const r = await fetch(`${SERVICE}?q=${encodeURIComponent(req.body.q.trim())}&limit=5`, { signal: AbortSignal.timeout(4000), referrerPolicy: 'no-referrer' });
      if (!r.ok) return reply.code(503).send({ erreur: 'adresse_indisponible' });
      const j = (await r.json()) as { features?: { properties: { label: string }; geometry: { coordinates: [number, number] } }[] };
      // Le service peut renvoyer deux fois le même libellé (une rue et un lieu-dit) : un seul suffit.
      const vus = new Set<string>();
      const uniques = (j.features ?? []).filter((f) => !vus.has(f.properties.label) && vus.add(f.properties.label));
      return reply.send({ resultats: uniques.map((f) => ({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })) });
    } catch {
      return reply.code(503).send({ erreur: 'adresse_indisponible' });
    }
  });

  app.post<{ Body: { lat: number; lon: number } }>('/adresse/inverse', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['lat', 'lon'], properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } } } },
  }, async (req, reply) => {
    const ip = empreinte(cles, 'ip', req.ip).toString('hex');
    if (!(await consommer(redis, `adresse-inverse:ip:${ip}`, 300, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    const cle = empreinte(cles, 'adresse-inverse', `${ip}|${req.body.lat.toFixed(5)},${req.body.lon.toFixed(5)}`).toString('hex');
    const garde = memoire.get(cle);
    if (garde && garde.expire > Date.now()) return reply.send({ adresse: garde.adresse });
    memoire.delete(cle);
    try {
      const r = await fetch(`${SERVICE_INVERSE}?lat=${req.body.lat}&lon=${req.body.lon}&limit=1`, { signal: AbortSignal.timeout(4000), referrerPolicy: 'no-referrer' });
      if (!r.ok) return reply.code(503).send({ erreur: 'adresse_indisponible' });
      const j = (await r.json()) as { features?: { properties: { label?: string; city?: string; postcode?: string; distance?: number } }[] };
      const p = j.features?.[0]?.properties;
      const adresse: AdresseProche | null = p?.label
        ? { label: p.label, commune: p.city ?? '', codePostal: p.postcode ?? '', distance: Math.round(p.distance ?? 0) }
        : null;   // en mer, hors de France : pas d'adresse
      if (memoire.size >= MEMOIRE_MAX) memoire.delete(memoire.keys().next().value!);
      memoire.set(cle, { adresse, expire: Date.now() + MEMOIRE_DUREE_MS });
      return reply.send({ adresse });
    } catch {
      return reply.code(503).send({ erreur: 'adresse_indisponible' });
    }
  });
}
