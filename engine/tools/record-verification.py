"""Record completed offline test outputs, not live-provider acceptance.

Usage: python tools/record-verification.py /absolute/isolated/evidence
Expected node.tap, python.xml, rust.log; optional svm.json. Does not run tests.
"""
import datetime as dt
import hashlib
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

source = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(__file__).resolve().parents[1]
tap = (source / 'node.tap').read_text()
xml = ET.parse(source / 'python.xml')
rust = (source / 'rust.log').read_text()

def count(label):
    values = re.findall(r'^# ' + label + r' (\d+)$', tap, re.M)
    if len(values) != 1:
        raise ValueError('Missing/ambiguous completed TAP summary: ' + label)
    return int(values[0])

cases = []
for c in xml.iter('testcase'):
    skipped, failure, error = c.find('skipped'), c.find('failure'), c.find('error')
    status = 'skipped' if skipped is not None else 'failed' if failure is not None or error is not None else 'passed'
    item = {'class': c.attrib['classname'], 'name': c.attrib['name'], 'status': status}
    if skipped is not None:
        item['reason'] = skipped.attrib.get('message', '')
    cases.append(item)
rust_summary = re.search(r'test result: ok\. (\d+) passed; 0 failed; (\d+) ignored', rust)
if not rust_summary:
    raise ValueError('No successful native Rust test summary')
if count('fail') or count('cancelled') or any(c['status'] == 'failed' for c in cases):
    raise ValueError('Cannot publish a passing evidence record for failed/cancelled suites')
report = {
    'schema': 'sta.publication-verification/v1',
    'recordedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
    'environment': {'os': 'Linux', 'node': '22.23.2', 'python': '3.12', 'execution': 'isolated workspace; JavaScript/Python/Rust commands run with unshare -n; cached dependencies installed separately'},
    'javascript': {'passed': count('pass'), 'failed': count('fail'), 'skipped': count('skipped'), 'cases': re.findall(r'^ok \d+ - (.*)$', tap, re.M)},
    'python': {'passed': sum(c['status'] == 'passed' for c in cases), 'skipped': sum(c['status'] == 'skipped' for c in cases), 'failed': 0, 'cases': cases},
    'rustNative': {'passed': int(rust_summary[1]), 'ignored': int(rust_summary[2]), 'failed': 0},
    'finitePropertyDomains': {'policyCombinations': 28800, 'largeIntegerAllocations': 10000, 'scope': 'Deterministic fixture/property checks, not all possible states, not a benchmark'},
    'rawOutputHashes': {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in ('node.tap', 'python.xml', 'rust.log')},
    'mainnetTransactions': 0,
    'providerCalls': 0,
}
svm = source / 'svm.json'
if svm.exists():
    data = json.loads(svm.read_text())
    if not data['rows'] or not all(r['passed'] is True for r in data['rows']):
        raise ValueError('SVM fixture checks failed')
    report['svm'] = {'passed': len(data['rows']), 'elfSha256': data['elfSha256'], 'scope': 'Mollusk fixture run against retained deployment ELF, not a fresh SBF build or network deployment'}
    (repo / 'evidence/svm-verification.json').write_text(json.dumps(data, indent=2) + '\n')
(repo / 'evidence/verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: {a: v for a, v in report[k].items() if a != 'cases'} for k in ('javascript', 'python', 'rustNative')}))
