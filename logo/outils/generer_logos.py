"""Génère les visuels d'Argos Veille en SVG, texte converti en tracés (Noto Sans, licence OFL).

Usage : python3 logo/outils/generer_logos.py logo   (nécessite fonttools : pip install fonttools)
Les PNG sont rendus à partir des SVG par un navigateur (taille ×2).
"""
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

SORTIE = Path(sys.argv[1])
NOIR, AMBRE, GRIS, BLANC = "#1F2328", "#E8A33D", "#4A4F57", "#FFFFFF"
POLICES = {
    "gras": TTFont("/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),
    "normal": TTFont("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"),
}


def largeur(texte: str, police: str, taille: float, espacement: float = 0) -> float:
    f = POLICES[police]
    echelle = taille / f["head"].unitsPerEm
    cmap, hmtx = f.getBestCmap(), f["hmtx"]
    return sum(hmtx[cmap[ord(c)]][0] * echelle for c in texte) + espacement * (len(texte) - 1)


def texte_en_traces(texte: str, police: str, taille: float, x: float, y: float, espacement: float = 0) -> str:
    """Chemin SVG du texte, ligne de base en y."""
    f = POLICES[police]
    echelle = taille / f["head"].unitsPerEm
    cmap, hmtx, glyphes = f.getBestCmap(), f["hmtx"], f.getGlyphSet()
    d = []
    for c in texte:
        nom = cmap[ord(c)]
        pen = SVGPathPen(glyphes)
        glyphes[nom].draw(TransformPen(pen, (echelle, 0, 0, -echelle, x, y)))
        d.append(pen.getCommands())
        x += hmtx[nom][0] * echelle + espacement
    return " ".join(d)


def etendu(texte: str, police: str, taille: float, x: float, y: float, cible: float) -> str:
    """Texte dont l'espacement est réglé pour occuper exactement la largeur cible."""
    nu = largeur(texte, police, taille)
    return texte_en_traces(texte, police, taille, x, y, (cible - nu) / (len(texte) - 1))


def repere(fond: str, encre: str) -> str:
    """Œil-repère (repère de carte + œil + anneau de petits yeux), cadre 200×200."""
    points = [(100, 53), (113.5, 56.6), (123.4, 66.5), (127, 80), (123.4, 93.5), (113.5, 103.4), (100, 107),
              (86.5, 103.4), (76.6, 93.5), (73, 80), (76.6, 66.5), (86.5, 56.6)]
    cercles = "".join(f'<circle cx="{x}" cy="{y}" r="2"/>' for x, y in points)
    return (f'<path d="M100 188 C100 188 38 122 38 80 A62 62 0 1 1 162 80 C162 122 100 188 100 188 Z" fill="{encre}"/>'
            f'<path d="M52 80 Q100 34 148 80 Q100 126 52 80 Z" fill="{fond}"/><g fill="{encre}">{cercles}</g>'
            f'<circle cx="100" cy="80" r="20" fill="{AMBRE}"/><circle cx="100" cy="80" r="8" fill="{NOIR}"/>')


def argos(x: float, y: float, taille: float, encre: str) -> tuple[str, float]:
    """« ARGOS » dont le O est un œil ; renvoie (svg, largeur)."""
    esp = taille * 0.075
    arg = texte_en_traces("ARG", "gras", taille, x, y, esp)
    x_o = x + largeur("ARG", "gras", taille, esp) + esp
    w_o = largeur("O", "gras", taille)
    cy = y - taille * 0.36
    trait = taille * 0.115
    oeil = (f'<path d="M{x_o + trait / 2:.1f} {cy:.1f} Q{x_o + w_o / 2:.1f} {cy - taille * 0.44:.1f} {x_o + w_o - trait / 2:.1f} {cy:.1f} '
            f'Q{x_o + w_o / 2:.1f} {cy + taille * 0.44:.1f} {x_o + trait / 2:.1f} {cy:.1f} Z" fill="none" stroke="{encre}" '
            f'stroke-width="{trait:.1f}" stroke-linejoin="round"/>'
            f'<circle cx="{x_o + w_o / 2:.1f}" cy="{cy:.1f}" r="{taille * 0.12:.1f}" fill="{AMBRE}"/>')
    x_s = x_o + w_o + esp
    s = texte_en_traces("S", "gras", taille, x_s, y)
    total = x_s + largeur("S", "gras", taille) - x
    return f'<path d="{arg} {s}" fill="{encre}"/>{oeil}', total


def svg(l: int, h: int, titre: str, corps: str, fond: str | None) -> str:
    rect = f'<rect width="{l}" height="{h}" fill="{fond}"/>' if fond else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {l} {h}" width="{l * 2}" height="{h * 2}">\n'
            f'  <title>{titre}</title>\n  {rect}\n  {corps}\n</svg>\n')


def logotype(fond: str, encre: str, encre2: str) -> str:
    mot, w = argos(24, 112, 100, encre)
    veille = etendu("VEILLE", "normal", 38, 26, 172, w - 4)
    filet = f'<rect x="24" y="130" width="{w:.0f}" height="4" fill="{AMBRE}"/>'
    return svg(int(w + 48), 196, "Argos Veille — logotype", mot + filet + f'<path d="{veille}" fill="{encre2}"/>', fond)


def logo_complet(fond: str, encre: str, encre2: str, devise: str) -> str:
    marque = f'<g transform="translate(18 20) scale(1)">{repere(fond, encre)}</g>'
    mot, w = argos(236, 106, 92, encre)
    veille = etendu("VEILLE", "normal", 34, 238, 160, w - 4)
    filet = f'<rect x="236" y="122" width="{w:.0f}" height="4" fill="{AMBRE}"/>'
    phrase = texte_en_traces("Ce que les réseaux effacent, Argos le garde", "normal", 21, 237, 204)
    l = int(max(236 + w, 237 + largeur("Ce que les réseaux effacent, Argos le garde", "normal", 21)) + 28)
    corps = marque + mot + filet + f'<path d="{veille}" fill="{encre2}"/><path d="{phrase}" fill="{devise}"/>'
    return svg(l, 232, "Argos Veille — logo complet", corps, fond)


def avatar(fond: str, encre: str) -> str:
    """Photo de profil (réseaux) : œil-repère seul, centré, marge pour le recadrage rond."""
    return svg(400, 400, "Argos Veille — avatar", f'<g transform="translate(70 62) scale(1.3)">{repere(fond, encre)}</g>', fond)


def banniere() -> str:
    """Bannière X (1500×500), fond anthracite : œil-repère, nom, devise, adresse du site."""
    mot, w = argos(560, 250, 132, BLANC)
    veille = etendu("VEILLE", "normal", 50, 563, 330, w - 6)
    filet = f'<rect x="560" y="272" width="{w:.0f}" height="6" fill="{AMBRE}"/>'
    phrase = texte_en_traces("Ce que les réseaux effacent, Argos le garde", "normal", 34, 562, 400)
    site = texte_en_traces("argos-veille.fr", "gras", 28, 562, 446)
    corps = (f'<g transform="translate(250 92) scale(1.55)">{repere(NOIR, BLANC)}</g>' + mot + filet
             + f'<path d="{veille}" fill="#C9CDD2"/><path d="{phrase}" fill="#C9CDD2"/><path d="{site}" fill="{AMBRE}"/>')
    return svg(1500, 500, "Argos Veille — bannière", corps, NOIR)


fichiers = {
    "c-logotype.svg": logotype(BLANC, NOIR, GRIS),
    "c-logotype-sombre.svg": logotype(NOIR, BLANC, "#C9CDD2"),
    "d-logo-complet.svg": logo_complet(BLANC, NOIR, GRIS, GRIS),
    "d-logo-complet-sombre.svg": logo_complet(NOIR, BLANC, "#C9CDD2", "#C9CDD2"),
    "e-avatar.svg": avatar(NOIR, BLANC),
    "f-banniere-x.svg": banniere(),
}
SORTIE.mkdir(parents=True, exist_ok=True)
for nom, contenu in fichiers.items():
    (SORTIE / nom).write_text(contenu)
    print(nom)
