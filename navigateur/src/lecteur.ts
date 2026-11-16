// Accès par morceaux à un fichier, sans le charger entièrement en mémoire (une vidéo peut faire 2 Go).

export interface Lecteur {
  readonly taille: number;
  /** Octets de [debut, fin[ (fin exclue, bornée à la taille). */
  lire(debut: number, fin: number): Promise<Uint8Array>;
}

/** Navigateur : un fichier choisi par la source (File ou Blob). */
export function lecteurBlob(blob: Blob): Lecteur {
  return {
    taille: blob.size,
    lire: async (debut, fin) => new Uint8Array(await blob.slice(debut, Math.min(fin, blob.size)).arrayBuffer()),
  };
}

/** Tests : un tableau d'octets en mémoire. */
export function lecteurOctets(octets: Uint8Array): Lecteur {
  return {
    taille: octets.length,
    lire: async (debut, fin) => octets.subarray(debut, Math.min(fin, octets.length)),
  };
}
