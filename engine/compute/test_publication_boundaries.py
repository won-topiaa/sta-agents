"""Failure corpus for the data boundary. Synthetic fixtures are not price evidence."""
import datetime as dt
import json
import pathlib
import tempfile
import unittest
import test_evaluate
from evaluate import load_prices

class ReleaseBoundaryChecks(unittest.TestCase):
    def test_future_or_timezone_free_manifest_is_rejected(self):
        for value in ['2099-01-01T00:00:00+00:00', '2026-09-29T00:00:00']:
            with tempfile.TemporaryDirectory() as root:
                p,_=test_evaluate.DataChecks().fixture(root,'date,adjclose\n2020-01-01,10\n')
                manifest=json.loads((p/'quant_release.json').read_text())
                manifest['created_at']=value
                (p/'quant_release.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError,'future|timezone'):
                    load_prices(root,['A'])

    def test_malformed_price_never_silently_shortens_the_sample(self):
        for price in ['garbage','NaN','Infinity','-1','0']:
            with tempfile.TemporaryDirectory() as root:
                test_evaluate.DataChecks().fixture(root,f'date,adjclose\n2020-01-01,{price}\n')
                with self.assertRaisesRegex(ValueError,'price'):
                    load_prices(root,['A'])

    def test_manifest_size_is_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            p=pathlib.Path(root)/'prices';p.mkdir()
            (p/'quant_release.json').write_bytes(b' '*2_000_001)
            with self.assertRaisesRegex(ValueError,'too large'):
                load_prices(root,['A'])

if __name__=='__main__':unittest.main()
