// Build a standalone deployment from an explicit source allowlist. This never
// includes attendance routes, production environment files or test fixtures.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const destination=path.join(root,'build/shift-deployment');
const shared=['shift-storage-boundary.mjs','shift-storage-boundary.d.mts','shift-http.mjs','shift-http.d.mts','shift-connected.mjs','shift-connected.d.mts','shift-trial.mjs','shift-trial.d.mts'];
const application=['app/layout.tsx','app/page.tsx','app/globals.css','app/shift-client.tsx','app/shift-workspace.tsx','app/shift-editor.tsx','app/api/requests/route.ts','next.config.ts','styles.d.ts','vercel.json'];
await mkdir(destination,{recursive:true});
for(const file of application){const target=path.join(destination,file);await mkdir(path.dirname(target),{recursive:true});await cp(path.join(root,'apps/shift',file),target);}
for(const file of shared){await mkdir(path.join(destination,'lib'),{recursive:true});await cp(path.join(root,'lib',file),path.join(destination,'lib',file));}
await cp(path.join(root,'app/shift/trial/shift-trial.module.css'),path.join(destination,'app/shift-trial.module.css'));
const tsconfig=JSON.parse(await readFile(path.join(root,'apps/shift/tsconfig.json'),'utf8'));
tsconfig.compilerOptions.paths={'@shared/*':['./lib/*'],'@trial-style':['./app/shift-trial.module.css']};
await writeFile(path.join(destination,'tsconfig.json'),JSON.stringify(tsconfig,null,2)+'\n');
// Reuse the root lockfile and installed versions; unused attendance dependencies
// do not add routes or credentials. A copied lockfile keeps npm ci reproducible.
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
pkg.scripts={dev:'next dev',build:'next build',start:'next start'};
await writeFile(path.join(destination,'package.json'),JSON.stringify(pkg,null,2)+'\n');
await cp(path.join(root,'package-lock.json'),path.join(destination,'package-lock.json'));
console.log(destination);
