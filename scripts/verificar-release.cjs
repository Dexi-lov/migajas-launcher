const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {buildSync}=require('esbuild'),{ed25519}=require('@noble/curves/ed25519'),{blake2b}=require('@noble/hashes/blake2.js');
const folder=path.resolve(process.argv[2]||'dist/oficial-1.2.14');
const temp=path.join(os.tmpdir(),'migajas-release-verify-'+process.pid+'.cjs');
try {
 const files=fs.readdirSync(folder),installers=files.filter(file=>file.endsWith('-setup.exe'));
 assert.equal(installers.length,1,'Debe existir exactamente un instalador de Windows en la carpeta.');
 const installer=installers[0],signature=fs.readFileSync(path.join(folder,installer+'.sig'),'utf8');
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,'latest.json'),'utf8'));
 const config=require('../src-tauri/tauri.conf.json');assert.equal(manifest.version,config.version,'La versión del manifiesto no coincide.');
 buildSync({entryPoints:[path.resolve(__dirname,'../supabase/functions/_shared/update-signature.ts')],bundle:true,platform:'node',outfile:temp,logLevel:'silent'});
 const {verifyUpdateSignature}=require(temp);
 const canonical=verifyUpdateSignature(fs.readFileSync(path.join(folder,installer)),signature,config.plugins.updater.pubkey,bytes=>blake2b(bytes,{dkLen:64}),(sig,message,key)=>ed25519.verify(sig,message,key,{zip215:false}),manifest.version);
 const platform=manifest.platforms?.['windows-x86_64'];assert(platform,'Falta la plataforma windows-x86_64.');
 assert.equal(platform.signature.trim(),canonical,'La firma del manifiesto no coincide con el instalador.');
 assert.equal(decodeURIComponent(new URL(platform.url).pathname.split('/').pop()),installer,'El enlace del manifiesto apunta a otro instalador.');
 const digest=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(folder,installer))).digest('hex');
 fs.writeFileSync(path.join(folder,'VERIFICACION.txt'),`Migajas Launcher ${manifest.version}\nFirma Ed25519 válida con la clave configurada del launcher.\nEXE, SIG y latest.json corresponden a la misma publicación.\nSHA-256: ${digest}\n`);
 console.log('OK: versión '+manifest.version+', firma válida con la clave configurada, manifiesto y EXE coincidentes. SHA-256: '+digest);
}catch(error){console.error('No se validó la publicación: '+error.message);process.exitCode=1;}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
