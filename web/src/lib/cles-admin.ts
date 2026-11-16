// Clés publiques d'administration (revue de sécurité A7) : c'est pour elles que la source chiffre l'autorisation de
// transmettre l'original. Elles sont ÉPINGLÉES ici, dans le code du site : un serveur compromis ou contraint ne peut pas
// glisser la sienne à la place (sinon les sources chiffreraient pour lui, sans trace). Changer de clé = changer ce
// fichier (et ARGOS_CLES_ADMIN côté serveur, qui refuse toute autre clé). En développement : celles du serveur local.
import { dev } from '$app/env';
import { get } from './api.ts';

/** YubiKey 5 NFC de l’administrateur, PIV 9d (même valeur que ARGOS_CLES_ADMIN dans deploiement/serveur/05-services.sh). */
export const CLES_ADMIN_EPINGLEES: readonly string[] = [
  'BHfqy0bshr71lHP6oOscEu9Xl/Z305/fceH/k0zYYHQ5cIAsCVfKthbbQskBhCSfLMYb43xHTlXkO3EJnR45aEw=',
];

/** Clés à utiliser pour chiffrer une autorisation : les épinglées en production, celles du serveur en développement. */
export async function clesAdmin(): Promise<string[]> {
  if (!dev) return [...CLES_ADMIN_EPINGLEES];
  return (await get<{ cles: string[] }>('/cles-admin')).cles;
}
