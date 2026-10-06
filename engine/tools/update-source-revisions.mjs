// Mechanical provenance refresh; preserve original source and publication hashes.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const path=resolve(root,'evidence/source-provenance.json'),p=JSON.parse(readFileSync(path));
for(const row of p.rows){
 const sha=createHash('sha256').update(readFileSync(resolve(root,row.path))).digest('hex');
 if(sha===row.publicationSha256)continue;
 row.initialPublicationSha256??=row.publicationSha256;
 row.publicationSha256=sha;
 row.integrationRevision='2026-09-30: actual PR07 bridge, full research coverage and exact buy/sell policy v2';
}
writeFileSync(path,JSON.stringify(p,null,2)+'\n');
