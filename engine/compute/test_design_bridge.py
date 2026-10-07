"""Bridge contract tests. Real history is optional; no model/chain requests."""
import copy
import os
import unittest
from design_bridge import prompt, evaluate_designs, held_of

REQUEST = {
    'strategy': {'objective': 'Study semiconductors without promising returns.',
                 'instruments': ['NVDA','AMD','AVGO','ASML','TSM','MU','INTC','MRVL']},
    'goal': {'horizonDays':365, 'targetReturnBps':500, 'maxDrawdownBps':4500,
             'maxWeightBps':2500, 'minCashBps':1000, 'costBps':50},
    'proposal': {'designs': {'candidates': [{
        'name':'Measured trend', 'idea':'Follow established trends while retaining cash when markets weaken.',
        'design': {'score':[{'signal':'momentum','lookback':126,'skip':21,'weight':1}],
                   'filters':[], 'top_n':None, 'weighting':'equal', 'risk_off':None}}]}}
}

AGENT = {'schema':'xtxc.agent-profile/v1','id':'5f1d2c3b-7a8e-4b9c-8d0e-1f2a3b4c5d6e','revision':1,'name':'Dip buyer',
         'style':'technical','preset':'dip','rules':[{'id':'uptrend_only','params':{'days':200}},{'id':'oversold_only','params':{'rsi_max':40}}],
         'philosophy':'','risk':{'maxWeightBps':2500,'minCashBps':1000,'maxDrawdownBps':4500},'rebalance':'weekly','approval':'PER_TRADE'}

class BridgeTest(unittest.TestCase):
    def test_original_prompt_and_no_prices(self):
        messages=prompt(REQUEST)
        self.assertEqual([m['role'] for m in messages], ['system','user'])
        self.assertIn('ASML',messages[1]['content'])
        self.assertIn('never code',messages[0]['content'])

    def test_no_executable_model_code(self):
        body=copy.deepcopy(REQUEST)
        body['proposal']['designs']['candidates'][0]['design']={'python':'import os'}
        with self.assertRaisesRegex(ValueError, 'no usable candidate'):
            evaluate_designs(body,'/nonexistent')

    def test_agent_prompt_and_risk_bounds(self):
        body=copy.deepcopy(REQUEST);body['agent']=AGENT
        messages=prompt(body)
        self.assertIn('"Dip buyer"',messages[1]['content'])
        self.assertIn('"rsi"',messages[1]['content'])
        self.assertIn('Rebalanced weekly',messages[1]['content'])
        looser=copy.deepcopy(body);looser['goal']['maxWeightBps']=4000
        with self.assertRaisesRegex(ValueError,"looser than the agent"):
            prompt(looser)
        broken=copy.deepcopy(body);broken['agent']['rules']=[{'id':'buy_the_rumour'}]
        with self.assertRaisesRegex(ValueError,'Agent profile rejected'):
            evaluate_designs(broken,'/nonexistent')

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_with_an_agent(self):
        body=copy.deepcopy(REQUEST);body['agent']=AGENT
        report=evaluate_designs(body,os.environ['XTXC_TEST_PRICE_ROOT'])
        self.assertEqual(report['agent']['name'],'Dip buyer')
        candidate=report['candidates'][0]
        self.assertTrue(candidate['agentChecks'])
        self.assertTrue(all(c['status']=='pass' for c in candidate['agentChecks']))
        self.assertIn({'signal':'rsi','lookback':14,'rule':'below','value':40.0},candidate['design']['filters'])
        self.assertEqual(candidate['modelDesign']['filters'],[])
        self.assertTrue(candidate['leakage']['passed'])
        self.assertIn('ISO week',' '.join(candidate['assumptions']))

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_with_a_value_agent(self):
        body=copy.deepcopy(REQUEST)
        body['strategy']['instruments']=['NVDA','AMD','INTC','MU','AAPL','MSFT','KO','PEP','JPM','WMT','PG','MCD']
        body['agent']={**AGENT,'name':'Deep value','style':'value','preset':'deep_value','rebalance':'monthly',
                       'rules':[{'id':'cheap_earnings','params':{'keep':0.5}},{'id':'cash_generating'},{'id':'low_debt','params':{'max':2.0}}]}
        body['proposal']={'designs':{'candidates':[{'name':'Cheap and sound','idea':'Buy the cheapest profitable companies by earnings yield.',
            'design':{'score':[{'signal':'earnings_yield','lookback':5,'weight':1},{'signal':'fcf_yield','lookback':5,'weight':0.5}],
                      'filters':[],'top_n':4,'weighting':'equal','risk_off':None}},
            {'name':'Momentum only','idea':'Ride recent winners without looking at the companies.',
             'design':{'score':[{'signal':'momentum','lookback':126,'weight':1}],'filters':[],'top_n':4,'weighting':'equal','risk_off':None}}]}}
        report=evaluate_designs(body,os.environ['XTXC_TEST_PRICE_ROOT'])
        self.assertTrue(report['dataset']['fundamentals']['available'])
        self.assertEqual([c['name'] for c in report['candidates']],['Cheap and sound'])     # the price-only design does not fit
        c=report['candidates'][0]
        self.assertTrue(all(x['status']=='pass' for x in c['agentChecks']))
        self.assertTrue(c['leakage']['passed'])
        self.assertTrue(set(w['instrument'] for w in c['weights'])<=set(body['strategy']['instruments']))

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_with_sector_dividend_and_volume_rules(self):
        body=copy.deepcopy(REQUEST)
        body['strategy']['instruments']=['KO','PEP','PG','WMT','JPM','XOM','CVX','IBM','MCD','UNH','HD','LOW']
        body['agent']={**AGENT,'name':'Dividend value','style':'value','preset':'dividend','rebalance':'monthly',
                       'rules':[{'id':'pays_dividend','params':{'min':0.015}},{'id':'cheaper_than_sector'},{'id':'liquid_only','params':{'min':7}}]}
        body['proposal']={'designs':{'candidates':[{'name':'Cheap income','idea':'Prefer cheap dividend payers on EBITDA.',
            'design':{'score':[{'signal':'ebitda_yield','lookback':5,'weight':1},{'signal':'dividend_yield','lookback':5,'weight':0.5}],
                      'filters':[],'top_n':4,'weighting':'equal','risk_off':None}}]}}
        report=evaluate_designs(body,os.environ['XTXC_TEST_PRICE_ROOT'])
        f=report['dataset']['fundamentals']
        self.assertGreater(f['sectorPeers'],10)                                       # medians use companies outside the request
        self.assertEqual(f['sectors']['XOM'],'energy')
        c=report['candidates'][0]
        self.assertTrue(all(x['status']=='pass' for x in c['agentChecks']))
        self.assertTrue(c['leakage']['passed'])

    def test_held_instruments_are_checked(self):
        tickers=REQUEST['strategy']['instruments']
        self.assertIsNone(held_of({}, tickers))
        self.assertEqual(held_of({'heldInstruments':['NVDA','TSLA','AMD','NVDA']}, tickers), ['AMD','NVDA'])
        self.assertEqual(held_of({'heldInstruments':[]}, tickers), [])
        for bad in ('NVDA', [1], ['X'*17], ['A']*65):
            with self.assertRaises(ValueError):
                held_of({'heldInstruments':bad}, tickers)

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_keeps_held_stocks_through_entry_filters(self):
        body=copy.deepcopy(REQUEST)
        body['proposal']['designs']['candidates'][0]['design']['filters']=[
            {'signal':'breakout','lookback':55,'rule':'above','value':0,'entry':True}]
        body['heldInstruments']=list(body['strategy']['instruments'])
        report=evaluate_designs(body,os.environ['XTXC_TEST_PRICE_ROOT'])
        self.assertEqual(report['heldInstruments'],sorted(body['strategy']['instruments']))
        c=report['candidates'][0]
        self.assertTrue(c['weights'])                                    # every stock is held: the entry filter is met
        self.assertNotIn('NO_CURRENT_ALLOCATION',c['reasons'])
        self.assertEqual(c['design']['filters'][0]['entry'],True)

    @unittest.skipUnless(os.environ.get('XTXC_TEST_PRICE_ROOT'), 'requires existing verified history')
    def test_real_history_through_original_pr07_executor(self):
        report=evaluate_designs(REQUEST,os.environ['XTXC_TEST_PRICE_ROOT'])
        self.assertEqual(report['engineVersion'],'sta-pr07-dsl-bridge/1')
        self.assertIn('ASML',report['dataset']['coverage'])
        candidate=report['candidates'][0]
        self.assertTrue(candidate['leakage']['passed'])
        self.assertTrue(candidate['curve'])
        self.assertLessEqual(sum(w['weightBps'] for w in candidate['weights']),9000)
        self.assertTrue(all(w['weightBps']<=2500 for w in candidate['weights']))
        self.assertGreaterEqual(candidate['windowCount'],3)

if __name__=='__main__':unittest.main()
