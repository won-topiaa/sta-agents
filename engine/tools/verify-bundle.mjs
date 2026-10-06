// Publication gate: metadata is not a substitute for execution evidence.
import {readdirSync, readFileSync, lstatSync, existsSync} from 'node:fs';
import {resolve, relative, dirname, sep} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'), ignored=new Set(['.git','node_modules','.venv','.pytest_cache','__pycache__','target','.local']);
const failures=[], files=[];
const fail=(path,rule)=>failures.push({path,rule});
function walk(dir){
  for(const name of readdirSync(dir).sort()){
    if(ignored.has(name))continue;
    const abs=resolve(dir,name),path=relative(root,abs).split(sep).join('/'),stat=lstatSync(abs);
    if(stat.isSymbolicLink()){fail(path,'symlink');continue;}
    if(stat.isDirectory()){if(/^(web-prev|runtime|arctic_store)/.test(name))fail(path,'excluded-directory');walk(abs);continue;}
    if(/\.(pem|key|sqlite(?:-wal|-shm)?|db|parquet|so|pyc|log)$/.test(name)||/keypair/i.test(name)||(/^\.env/.test(name)&&name!=='.env.example'))fail(path,'private-or-generated-file');
    if(stat.size>2_000_000){fail(path,'unexpected-large-file');continue;}
    const bytes=readFileSync(abs),text=bytes.toString('utf8');
    const rules={
      'private-key':/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      'provider-token':/\bsk-(?:bk-|proj-)[A-Za-z0-9_-]{20,}/,
      'github-token':/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
      'jwt':/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
      'credential-url':/https?:\/\/[^\s"']*(?:[?&]api[-_]key=[^\s"'&]{8,}|\.quiknode\.pro\/[^\s"'/]{16,})/,
    };
    for(const [rule,rx] of Object.entries(rules))if(rx.test(text))fail(path,rule);
    files.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),text});
  }
}
walk(root);
const byPath=new Map(files.map(f=>[f.path,f]));
for(const file of files.filter(f=>f.path.endsWith('.md'))){
  for(const match of file.text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)){
    const target=match[1];if(/^(https?:|mailto:|#)/.test(target))continue;
    const abs=resolve(dirname(resolve(root,file.path)),target.split('#')[0]);
    if(relative(root,abs).startsWith('..')||!existsSync(abs))fail(file.path,'broken-relative-link:'+target);
  }
}
const provenance=JSON.parse(readFileSync(resolve(root,'evidence/source-provenance.json')));
for(const row of provenance.rows){
  const f=byPath.get(row.path);
  if(!f||f.sha256!==row.publicationSha256)fail(row.path,'provenance-drift');
  if(!/^[0-9a-f]{64}$/.test(row.sourceSha256))fail(row.path,'invalid-source-hash');
}
const digest=createHash('sha256').update(files.map(f=>`${f.sha256}  ${f.path}\n`).join('')).digest('hex');
console.log(JSON.stringify({schema:'sta.publication-gate/v1',files:files.length,sourceRows:provenance.rows.length,treeDigest:digest,failures},null,2));
if(failures.length)process.exitCode=1;
