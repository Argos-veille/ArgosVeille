// Signature AWS SigV4 vérifiée avec les exemples officiels de la documentation d'Amazon S3
// (« Signature Calculations for the Authorization Header » et « Authenticating Requests: Using Query Parameters »).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preSigner, R2, signerEntetes } from '../src/r2.ts';

// Clés FICTIVES publiées par Amazon dans sa documentation (pas des secrets).
const EXEMPLE = { hote: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', cleAcces: 'AKIAIOSFODNN7EXAMPLE', // gitleaks:allow
                  secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') }; // gitleaks:allow

test('SigV4 : adresse pré-signée identique à l\'exemple d\'Amazon', () => {
  const url = preSigner({ ...EXEMPLE, methode: 'GET', chemin: '/test.txt', secondes: 86400 });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('SigV4 : en-tête d\'autorisation identique à l\'exemple d\'Amazon (GET avec Range)', () => {
  const h = signerEntetes({ ...EXEMPLE, methode: 'GET', chemin: '/test.txt', entetes: { range: 'bytes=0-9' },
                            empreinteCorps: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.match(h.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('R2 : place occupée, toutes les pages de la liste lues', async () => {
  const urls: string[] = [];
  const pages = [
    '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a+b/c</NextContinuationToken>'
      + '<Contents><Key>x</Key><Size>100</Size></Contents><Contents><Key>y</Key><Size>23</Size></Contents></ListBucketResult>',
    '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>z</Key><Size>7</Size></Contents></ListBucketResult>',
  ];
  const faux = (async (url: string) => { urls.push(url); return new Response(pages[urls.length - 1]!); }) as unknown as typeof fetch;
  const r2 = new R2({ point: 'https://compte.eu.r2.cloudflarestorage.com', compartiment: 'argos', cleAcces: 'A', secret: 'S' }, faux);
  assert.deepEqual(await r2.occupation(), { fichiers: 3, octets: 130 });
  assert.match(urls[0]!, /\?list-type=2$/);
  assert.match(urls[1]!, /\?continuation-token=a%2Bb%2Fc&list-type=2$/);
});
