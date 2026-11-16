"""Audit H9 : aucun identifiant de vidéo dans les journaux du worker."""
import io
import logging
import unittest

from argos_worker import journaux

VID = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"


class TestJournaux(unittest.TestCase):
    def test_message_et_trace_sans_identifiant(self):
        flux = io.StringIO()
        h = logging.StreamHandler(flux)
        h.addFilter(journaux.SansIdentifiant())
        j = logging.getLogger("test_journaux")
        j.addHandler(h)
        j.propagate = False
        j.warning("traitement de %s (tentative %d)", VID, 2)
        try:
            raise OSError(f"/srv/argos/donnees/floutees/{VID}/video.mp4 introuvable")
        except OSError:
            j.exception("échec de %s", VID)
        sortie = flux.getvalue()
        self.assertNotIn(VID, sortie)
        self.assertIn("traitement de <vidéo> (tentative 2)", sortie)
        self.assertIn("floutees/<vidéo>/video.mp4", sortie)   # la trace reste utile, sans l'identifiant
        j.warning("sans tirets : %s", VID.replace("-", ""))
        self.assertNotIn(VID.replace("-", ""), flux.getvalue())


if __name__ == "__main__":
    unittest.main()
