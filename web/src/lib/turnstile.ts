// Test anti-robot Turnstile de Cloudflare (exception assumée à « aucune ressource extérieure », décidée
// le 5 novembre 2026). Le script n'est chargé qu'au moment où une page demande un jeton. Le widget reste
// invisible pour la plupart des visiteurs (« interaction-only ») et n'apparaît qu'en cas de doute.
// En développement sans clé de site : jeton factice, que la clé secrète de test de l'API accepte.

interface Turnstile {
  render(el: HTMLElement, o: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }

const CLE = __ARGOS_TURNSTILE__;
let chargement: Promise<Turnstile> | null = null;

function charger(): Promise<Turnstile> {
  chargement ??= new Promise<Turnstile>((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.turnstile ? ok(window.turnstile) : ko(new Error('turnstile')));
    s.onerror = () => { chargement = null; ko(new Error('turnstile_indisponible')); };
    document.head.append(s);
  });
  return chargement;
}

export async function jetonTurnstile(): Promise<string> {
  if (!CLE) return 'XXXX.DUMMY.TOKEN.XXXX';
  const t = await charger();
  return new Promise<string>((ok, ko) => {
    const cadre = document.createElement('div');
    cadre.className = 'cadre-turnstile';
    document.body.append(cadre);
    let id = '';
    const fin = () => { try { t.remove(id); } catch { /* déjà retiré */ } cadre.remove(); };
    id = t.render(cadre, {
      sitekey: CLE, appearance: 'interaction-only', language: 'fr', theme: 'auto',
      callback: (jeton: string) => { fin(); ok(jeton); },
      'error-callback': () => { fin(); ko(new Error('turnstile_echec')); },
      'timeout-callback': () => { fin(); ko(new Error('turnstile_echec')); },
    });
  });
}
