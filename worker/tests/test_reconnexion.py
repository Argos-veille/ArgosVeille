"""Base redémarrée (mise à jour de PostgreSQL) : le worker se reconnecte au lieu de s'arrêter.

    cd worker && .venv/bin/python -m unittest tests.test_reconnexion
"""
import unittest
from unittest import mock

import psycopg

from argos_worker import boucle


class Arret(Exception):
    pass


class TestReconnexion(unittest.TestCase):
    def setUp(self):
        self.cx1 = mock.Mock(closed=False)
        self.cx2 = mock.Mock(closed=False)
        patchs = [
            mock.patch.object(boucle, "redis_cles"),
            mock.patch.object(boucle.time, "sleep"),
            mock.patch("argos_worker.ancrage.tour"),
        ]
        for p in patchs:
            p.start()
            self.addCleanup(p.stop)

    def test_connexion_perdue_puis_reprise(self):
        def coupure(cx, c, r):
            if cx is self.cx1:
                self.cx1.closed = True
                raise psycopg.OperationalError("the connection is closed")
            raise Arret
        with mock.patch.object(boucle, "connexion", side_effect=[self.cx1, self.cx2]) as connexion, \
                mock.patch.object(boucle, "traiter_une", side_effect=coupure):
            with self.assertRaises(Arret):
                boucle.tourner(mock.Mock())
        self.assertEqual(connexion.call_count, 2)
        self.cx2.close.assert_called_once()

    def test_base_injoignable_au_demarrage(self):
        with mock.patch.object(boucle, "connexion",
                               side_effect=[psycopg.OperationalError("refusée"), self.cx2]) as connexion, \
                mock.patch.object(boucle, "traiter_une", side_effect=Arret):
            with self.assertRaises(Arret):
                boucle.tourner(mock.Mock())
        self.assertEqual(connexion.call_count, 2)

    def test_autre_erreur_connexion_ouverte_remonte(self):
        with mock.patch.object(boucle, "connexion", return_value=self.cx1), \
                mock.patch.object(boucle, "traiter_une", side_effect=psycopg.OperationalError("autre")):
            with self.assertRaises(psycopg.OperationalError):
                boucle.tourner(mock.Mock())
        self.cx1.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
