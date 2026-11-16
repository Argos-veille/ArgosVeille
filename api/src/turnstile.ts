// Vérification du test anti-robot Cloudflare Turnstile, côté serveur.
// En développement, la clé secrète de test 1x0000000000000000000000000000000AA accepte tout.

export interface Turnstile {
  verifier(reponse: string): Promise<boolean>;
}

export class TurnstileCloudflare implements Turnstile {
  constructor(private readonly secret: string) {}

  async verifier(reponse: string): Promise<boolean> {
    if (!reponse || reponse.length > 2048) return false;
    // L'adresse IP du visiteur n'est volontairement pas transmise (facultative pour Cloudflare).
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: this.secret, response: reponse }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return false;
    const corps = (await r.json()) as { success?: unknown };
    return corps.success === true;
  }
}
