// Déclaration minimale de nodemailer (le paquet ne fournit pas ses types) : seulement ce qu'Argos utilise.
declare module 'nodemailer' {
  export interface Envoi {
    from: string; to: string; subject: string; text: string;
    headers?: Record<string, string>;
  }
  export interface Resultat { messageId: string; message?: Buffer | string; accepted?: string[]; rejected?: string[] }
  export interface Transport {
    sendMail(envoi: Envoi): Promise<Resultat>;
    verify(): Promise<true>;
    close(): void;
  }
  export interface OptionsSmtp {
    host?: string; port?: number; secure?: boolean; requireTLS?: boolean;
    auth?: { user: string; pass: string };
    tls?: { minVersion?: string; servername?: string };
    connectionTimeout?: number; greetingTimeout?: number; socketTimeout?: number;
    streamTransport?: boolean; buffer?: boolean; newline?: 'unix' | 'windows';
  }
  export function createTransport(options: OptionsSmtp): Transport;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
