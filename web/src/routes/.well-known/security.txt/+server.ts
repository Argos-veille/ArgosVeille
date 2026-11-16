// security.txt (RFC 9116) : où signaler une faille. À renouveler avant « Expires » (au plus un an).
import { CONTACT } from '#lib/legal.ts';

const TEXTE = [
  `Contact: mailto:${CONTACT.mail}`,
  'Contact: https://argos-veille.fr/securite',
  'Expires: 2027-11-16T00:00:00.000Z',
  'Policy: https://argos-veille.fr/securite',
  'Preferred-Languages: fr, en',
  'Canonical: https://argos-veille.fr/.well-known/security.txt',
  '',
].join('\n');

export const prerender = true;

export const GET = () => new Response(TEXTE, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
