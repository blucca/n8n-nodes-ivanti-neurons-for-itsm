#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Local fixture: Ivanti's reported default-25 OData paging, not a live tenant.
import argparse,json,os,resource,secrets,signal,subprocess,threading,time
from collections import Counter
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,parse_qs

parser=argparse.ArgumentParser()
parser.add_argument('--runtime',required=True);parser.add_argument('--stock',required=True);parser.add_argument('--fixed',required=True);parser.add_argument('--out',required=True)
a=parser.parse_args();out=Path(a.out).resolve();out.mkdir(parents=True,exist_ok=False)
package='@synergyconsulting/n8n-nodes-ivanti-neurons-for-itsm';node_type=package+'.ivantiNeuronsForItsm'
action_ids={n:f'{n:032X}' for n in [0,37,100,137]};counts={v:k for k,v in action_ids.items()};requests=[]
endpoint='/api/odata/businessobject/Incidents/All_Active_Incidents'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  u=urlsplit(self.path);q={k:v[0] for k,v in parse_qs(u.query).items()};action=q.get('ActionId');total=counts.get(action)
  auth=self.headers.get('Authorization');top=int(q.get('$top','25'));skip=int(q.get('$skip','0'))
  ok=u.path==endpoint and total is not None and auth in ['rest_api_key=fixture-only','rest_api_key=override-fixture']
  rows=[{'RecId':f'rec-{i:03d}','Subject':f'Incident {i}'} for i in range(total or 0)][skip:skip+top] if ok else []
  # A full-page dataset ends with 204; a genuinely empty initial search returns {value:[]}.
  status=204 if ok and total==100 and skip==100 else 200 if ok else 400
  body=b'' if status==204 else json.dumps({'value':rows} if ok else {'message':['Unexpected fixture request']}).encode()
  requests.append({'path':u.path,'query':q,'authorization':auth,'x_fixture':self.headers.get('X-Fixture'),'status':status,'returned':len(rows)})
  (out/'http-requests.json').write_text(json.dumps(requests,indent=2))
  self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
tenant=f'http://127.0.0.1:{server.server_port}';runtime=Path(a.runtime).resolve();cli=runtime/'node_modules/n8n/bin/n8n'
assert cli.is_file()
report={'scope':'n8n 2.46.6; real community-package loader and HTTP transport; local reported default-25 fixture; no live Ivanti calls','node':subprocess.check_output(['node','--version'],text=True).strip(),'n8n':json.loads((runtime/'node_modules/n8n/package.json').read_text())['version'],'package':package,'runs':[],'cases':{}}
fixed_cases=[('Legacy37',37,1.3,{},25),('Default37',37,1.4,{},37),('All137',137,1.4,{'returnAll':True,'requestOptions':{'overrideHeaders':{'header':[{'name':'Authorization','value':'rest_api_key=override-fixture'},{'name':'X-Fixture','value':'all137'}]}}},137),('Limit120',137,1.4,{'returnAll':False,'limit':120},120),('Limit10',37,1.4,{'returnAll':False,'limit':10},10),('Empty',0,1.4,{},0),('Exactly100',100,1.4,{},100)]
def invoke(mode,stage,args,env,folder):
 start=time.monotonic()
 with (folder/(stage+'.stdout.log')).open('w') as stdout,(folder/(stage+'.stderr.log')).open('w') as stderr:
  p=subprocess.Popen(['node',str(cli),*args],cwd=folder,env=env,stdout=stdout,stderr=stderr,start_new_session=True)
  try:rc=p.wait(timeout=90)
  finally:
   try:os.killpg(p.pid,signal.SIGTERM)
   except ProcessLookupError:pass
 row={'mode':mode,'stage':stage,'rc':rc,'seconds':round(time.monotonic()-start,3),'child_peak_rss_kib':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}
 report['runs'].append(row);(out/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps(row),flush=True);assert rc==0,row

def read_execution(text):
 decoder=json.JSONDecoder()
 for i,c in enumerate(text):
  if c!='{':continue
  try:obj,_=decoder.raw_decode(text[i:])
  except json.JSONDecodeError:continue
  if isinstance(obj,dict) and isinstance(obj.get('data'),dict) and 'resultData' in obj['data']:return obj
 raise AssertionError('No real raw execution data')
try:
 for mode,source,cases in [('stock',a.stock,[fixed_cases[0]]),('fixed',a.fixed,fixed_cases)]:
  folder=out/mode;folder.mkdir();home=folder/'home';installed=home/'.n8n/nodes/node_modules/@synergyconsulting';installed.mkdir(parents=True)
  (installed/'n8n-nodes-ivanti-neurons-for-itsm').symlink_to(Path(source).resolve(),target_is_directory=True)
  nodes=[{'id':'start','name':'Start','type':'n8n-nodes-base.manualTrigger','typeVersion':1,'position':[0,0],'parameters':{}}]
  for index,(name,n,version,params,expected) in enumerate(cases):
   parameters={'resource':'search','operation':'savedSearch','searchObject':'Incidents','savedSearchName':'All_Active_Incidents','savedSearchGUID':action_ids[n],**params}
   nodes.append({'id':name,'name':name,'type':node_type,'typeVersion':version,'position':[300,index*120],'parameters':parameters,'credentials':{'ivantiNeuronsForItsmApiKeyApi':{'id':'ivanti-fixture-only','name':'Ivanti fixture only'}}})
  workflow={'id':'ivantiNative599','name':'Ivanti Saved Search native '+mode,'active':False,'nodes':nodes,'connections':{'Start':{'main':[[{'node':name,'type':'main','index':0} for name,*_ in cases]]}},'settings':{'executionOrder':'v1','saveManualExecutions':True},'pinData':{}}
  (folder/'workflow.json').write_text(json.dumps(workflow,indent=2))
  (folder/'credentials.json').write_text(json.dumps([{'id':'ivanti-fixture-only','name':'Ivanti fixture only','type':'ivantiNeuronsForItsmApiKeyApi','data':{'tenant':tenant,'apiKey':'fixture-only','isOnPrem':False,'skipSslVerification':False}}],indent=2))
  env={k:v for k,v in os.environ.items() if k.lower() not in ['http_proxy','https_proxy','all_proxy']}
  env.update(HOME=str(home),TMPDIR=str(folder),N8N_USER_FOLDER=str(home),N8N_ENCRYPTION_KEY=secrets.token_hex(32),N8N_DIAGNOSTICS_ENABLED='false',N8N_VERSION_NOTIFICATIONS_ENABLED='false',N8N_TEMPLATES_ENABLED='false',N8N_PERSONALIZATION_ENABLED='false',N8N_COMMUNITY_PACKAGES_ENABLED='true',N8N_COMMUNITY_PACKAGES_PREVENT_LOADING='false',N8N_REINSTALL_MISSING_PACKAGES='false',N8N_RUNNERS_ENABLED='false',N8N_DEFAULT_BINARY_DATA_MODE='default',NODE_OPTIONS='--max-old-space-size=512',NODES_INCLUDE=json.dumps(['n8n-nodes-base.manualTrigger',node_type]),EXECUTIONS_DATA_SAVE_ON_SUCCESS='all',EXECUTIONS_DATA_SAVE_ON_ERROR='all')
  request_start=len(requests)
  invoke(mode,'credentials',['import:credentials','--input',str(folder/'credentials.json')],env,folder)
  invoke(mode,'import',['import:workflow','--input',str(folder/'workflow.json')],env,folder)
  invoke(mode,'execute',['execute','--id','ivantiNative599','--rawOutput'],env,folder)
  execution=read_execution((folder/'execute.stdout.log').read_text());(folder/'execution.json').write_text(json.dumps(execution,indent=2))
  assert execution.get('status')=='success' and execution.get('finished') is True and not execution['data']['resultData'].get('error'),execution
  rd=execution['data']['resultData']['runData'];observed={}
  for name,n,version,params,expected in cases:
   runs=rd[name];assert len(runs)==1 and not runs[0].get('error'),(mode,name,runs)
   items=runs[0].get('data',{}).get('main',[[]])[0] or []
   want=[{'RecId':f'rec-{i:03d}','Subject':f'Incident {i}'} for i in range(expected)]
   assert [item['json'] for item in items]==want,(mode,name,'records')
   assert all(item.get('pairedItem')=={'item':0} for item in items),(mode,name,'pairedItem')
   observed[name]={'type_version':version,'matching_fixture_records':n,'output_count':len(items),'full_record_match':True,'complete_search_contract':len(items)==n,'ordered_ids':[x['json']['RecId'] for x in items]}
  http=requests[request_start:];observed['http']=http;report['cases'][mode]=observed
  (out/'results.json').write_text(json.dumps(report,indent=2))
 assert report['cases']['stock']['Legacy37']==report['cases']['fixed']['Legacy37']
 assert report['cases']['stock']['http']==[r for r in report['cases']['fixed']['http'] if '$top' not in r['query']]
 actual=[r['query'] for r in report['cases']['fixed']['http']]
 expected=[{'ActionId':action_ids[37]}, {'ActionId':action_ids[37],'$top':'100','$skip':'0'}, {'ActionId':action_ids[137],'$top':'100','$skip':'0'}, {'ActionId':action_ids[137],'$top':'100','$skip':'100'}, {'ActionId':action_ids[137],'$top':'100','$skip':'0'}, {'ActionId':action_ids[137],'$top':'20','$skip':'100'}, {'ActionId':action_ids[37],'$top':'10'}, {'ActionId':action_ids[0],'$top':'100','$skip':'0'}, {'ActionId':action_ids[100],'$top':'100','$skip':'0'}, {'ActionId':action_ids[100],'$top':'100','$skip':'100'}]
 assert Counter(json.dumps(q,sort_keys=True) for q in actual)==Counter(json.dumps(q,sort_keys=True) for q in expected),actual
 all_requests=[r for r in report['cases']['fixed']['http'] if r['x_fixture']=='all137']
 assert len(all_requests)==2
 assert [r['query']['$skip'] for r in all_requests]==['0','100']
 assert all(r['authorization']=='rest_api_key=override-fixture' and r['x_fixture']=='all137' for r in all_requests)
 assert len([r for r in report['cases']['fixed']['http'] if r['status']==204])==1
 report['verdict']='PASS: original green 25/37 reproduced; old path preserved; new default/full/limited/empty/204 paging and real headers/ActionId/paired items verified'
 (out/'results.json').write_text(json.dumps(report,indent=2));print(report['verdict'],flush=True)
finally:
 server.shutdown();server.server_close();thread.join(timeout=5)
