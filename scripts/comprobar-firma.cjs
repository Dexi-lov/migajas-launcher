const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {buildSync}=require('esbuild'),{ed25519}=require('@noble/curves/ed25519'),{blake2b}=require('@noble/hashes/blake2.js');
const fixture=path.join(os.tmpdir(),'migajas-firma-'+process.pid+'.txt'),bundle=fixture+'.cjs';
try{
 fs.writeFileSync(fixture,'Prueba de firma de Migajas. No es un instalador.');
 cp.execFileSync(process.execPath,[require.resolve('@tauri-apps/cli/tauri.js'),'signer','sign','--app-version',require('../package.json').version,fixture],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 buildSync({entryPoints:[path.resolve(__dirname,'../supabase/functions/_shared/update-signature.ts')],bundle:true,platform:'node',outfile:bundle,logLevel:'silent'});
 require(bundle).verifyUpdateSignature(fs.readFileSync(fixture),fs.readFileSync(fixture+'.sig','utf8'),require('../src-tauri/tauri.conf.json').plugins.updater.pubkey,bytes=>blake2b(bytes,{dkLen:64}),(sig,message,key)=>ed25519.verify(sig,message,key,{zip215:false}),require('../package.json').version);
 console.log('OK: la clave privada firma correctamente y coincide con la clave pública del launcher.');
}catch{console.error('La clave no pudo firmar o no coincide con la clave pública. No se imprimieron credenciales.');process.exitCode=1;}
finally{for(const file of [fixture,fixture+'.sig',bundle])if(fs.existsSync(file))fs.unlinkSync(file);}
