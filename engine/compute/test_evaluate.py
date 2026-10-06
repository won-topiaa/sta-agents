"""Focused failure checks; fixtures are never product/performance evidence."""
import unittest, tempfile, pathlib, json, gzip, hashlib, datetime as dt
from evaluate import load_prices, assess

class DataChecks(unittest.TestCase):
    def fixture(self, root, text):
        raw=text.encode(); h=hashlib.sha256(raw).hexdigest()
        p=pathlib.Path(root)/'prices';(p/'objects').mkdir(parents=True,exist_ok=True)
        (p/'objects'/(h+'.csv.gz')).write_bytes(gzip.compress(raw))
        doc={'schema':'xtxc.research.quant-release/v1','source':'xtxc-quant-store/verified-v1','release_id':'fixture', 'created_at':dt.datetime.now(dt.timezone.utc).isoformat(),'tickers':{'A':{'object':h,'verification':{'ok':True},'provenance':'fixture'}}}
        (p/'quant_release.json').write_text(json.dumps(doc));return p,h
    def test_missing_is_not_synthetic_history(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'WAITING_DATA'):load_prices(d,['A'])
    def test_corrupt_object_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p,h=self.fixture(d,'date,adjclose\n2026-09-28,10\n')
            (p/'objects'/(h+'.csv.gz')).write_bytes(gzip.compress(b'changed'))
            with self.assertRaisesRegex(ValueError,'hash mismatch'):load_prices(d,['A'])
    def test_future_and_duplicate_sessions(self):
        for text in ['date,adjclose\n2099-01-01,10\n','date,adjclose\n2020-01-01,10\n2020-01-01,11\n']:
            with tempfile.TemporaryDirectory() as d:
                self.fixture(d,text)
                with self.assertRaises(ValueError):load_prices(d,['A'])
    def test_unverified_source_is_not_usable(self):
        with tempfile.TemporaryDirectory() as d:
            p,_=self.fixture(d,'date,adjclose\n2026-09-28,10\n');doc=json.loads((p/'quant_release.json').read_text());doc['tickers']['A']['verification']['ok']=False;(p/'quant_release.json').write_text(json.dumps(doc))
            with self.assertRaisesRegex(ValueError,'Unverified'):load_prices(d,['A'])
    def test_short_holdout_rejected(self):
        with self.assertRaisesRegex(ValueError,'three held-out'):assess({'equity':[[str(i),100+i] for i in range(300)]},{'horizonDays':365,'targetReturnBps':100,'maxDrawdownBps':2000})
    def test_extreme_return_target_refused(self):
        result=assess({'equity':[[str(i),100+i*.1] for i in range(1300)]},{'horizonDays':365,'targetReturnBps':100000,'maxDrawdownBps':2000})
        self.assertEqual(result['verdict'],'DECLINED');self.assertIn('TARGET_NOT_SUPPORTED',result['reasons']);self.assertGreaterEqual(result['windowCount'],3)

if __name__=='__main__':unittest.main()
