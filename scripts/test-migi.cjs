const assert=require('node:assert/strict'),{buildSync}=require('esbuild'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const file=path.join(os.tmpdir(),'migi-test-'+process.pid+'.cjs');buildSync({entryPoints:['cloudflare/migi/index.ts'],bundle:true,platform:'node',outfile:file,logLevel:'silent'});const worker=require(file).default;fs.unlinkSync(file);
(async()=>{
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);const key=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex');
 const env={DISCORD_APPLICATION_ID:'app',DISCORD_PUBLIC_KEY:key,DISCORD_GUILD_ID:'guild'};
 async function request(input,options={}){const body=JSON.stringify({application_id:'app',guild_id:'guild',...input}),timestamp=String(Math.floor(Date.now()/1000)-(options.old?600:0));const signature=Buffer.from(await crypto.subtle.sign('Ed25519',pair.privateKey,Buffer.from(timestamp+body))).toString('hex');return worker.fetch(new Request('https://migi.test/interactions',{method:'POST',headers:{'x-signature-ed25519':options.bad?'0'.repeat(128):signature,'x-signature-timestamp':timestamp},body}),env);}
 assert.equal((await request({type:1})).status,200);assert.deepEqual(await(await request({type:1})).json(),{type:1});
 assert.equal((await request({type:1},{bad:true})).status,401);assert.equal((await request({type:1},{old:true})).status,401);assert.equal((await request({type:1,application_id:'other'})).status,403);
 const invoke=(sub,permissions='0',topic)=>request({type:2,data:{name:'migi',options:[{name:sub,options:[{name:'tema',value:topic}]}]},member:{permissions}}).then(r=>r.json());
 assert.equal((await invoke('bienvenida')).data.flags,64);const welcome=await invoke('bienvenida','32');assert(!welcome.data.flags);assert.match(welcome.data.embeds[0].title,/nueva era/);assert.deepEqual(welcome.data.allowed_mentions,{parse:[]});
 assert.match((await invoke('ayuda','0','controles')).data.embeds[0].description,/clic derecho/);assert.equal((await invoke('ayuda','0','amigos')).data.flags,64);assert.match((await invoke('novedades')).data.embeds[0].title,/1.2.14/);
 const foreign=await request({type:2,guild_id:'other'});assert.equal((await foreign.json()).data.flags,64);
 assert.equal((await worker.fetch(new Request('https://migi.test/health'),env)).status,200);
 console.log('OK: Migi verifica firmas reales, rechaza firmas falsas y antiguas, limita el anuncio a administradores y responde ayuda y novedades.');
})().catch(error=>{console.error(error);process.exitCode=1;});
