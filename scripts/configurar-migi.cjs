const readline=require('node:readline');
const config=require('../cloudflare/migi/wrangler.json').vars;
const endpoint='https://migi-discord.migajas-studio.workers.dev/interactions';
const command={name:'migi',description:'Tu palomita de ayuda de Migajas Studio',type:1,options:[
 {type:1,name:'bienvenida',description:'Publica la bienvenida a la nueva era (solo Administración)'},
 {type:1,name:'novedades',description:'Conoce las novedades del launcher'},
 {type:1,name:'ayuda',description:'Pregúntame sobre el launcher',options:[{type:3,name:'tema',description:'¿En qué te ayudo?',required:true,choices:['jugar','skin','ram','controles','amigos','borrar','soporte'].map(value=>({name:value,value}))}]}
]};
async function hiddenToken(){
 if(process.env.MIGI_DISCORD_BOT_TOKEN)return process.env.MIGI_DISCORD_BOT_TOKEN.trim();
 if(!process.stdin.isTTY)throw Error('Ejecuta npm run migi:configurar en tu terminal para pegar el token de forma oculta.');
 process.stdout.write('Pega el Bot Token de Migi (no se mostrará ni guardará) y pulsa Enter: ');
 readline.emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';function clean(){process.stdin.off('keypress',key);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}function key(text,event){if(event?.ctrl&&event.name==='c'){clean();reject(Error('Configuración cancelada.'));return;}if(event?.name==='return'){clean();resolve(value.trim());return;}if(event?.name==='backspace'){value=value.slice(0,-1);return;}if(text&&!event?.ctrl&&!event?.meta)value+=text;}process.stdin.on('keypress',key);});
}
async function configure(){
 let token=await hiddenToken();if(!token||/[\r\n\s]/.test(token))throw Error('El token no es válido. Copia solamente el Bot Token, sin espacios.');
 async function api(path,method='GET',body){const response=await fetch('https://discord.com/api/v10'+path,{method,headers:{Authorization:'Bot '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Discord respondió HTTP '+response.status+'. Revisa el token de Migi, su acceso al servidor y los permisos.');return response.json();}
 try{
  const app=await api('/applications/@me');if(app.id!==config.DISCORD_APPLICATION_ID)throw Error('Ese token pertenece a otra aplicación. Debe ser el de Migi.');
  const avatar=require('node:fs').readFileSync(require('node:path').join(__dirname,'../assets/migi.png')).toString('base64');
  await api('/users/@me','PATCH',{avatar:'data:image/png;base64,'+avatar});
  await api('/applications/@me','PATCH',{interactions_endpoint_url:endpoint,description:'Soy Migi, la palomita de Migajas Studio. Te acompaño con los eventos, tus amigos y el launcher.'});
  await api(`/applications/${config.DISCORD_APPLICATION_ID}/guilds/${config.DISCORD_GUILD_ID}/commands`,'POST',command);
  console.log('Migi está conectado y tiene su foto de palomita. En Migajas Studio escribe /migi ayuda, /migi novedades o /migi bienvenida.');
 }finally{token='';}
}
if(require.main===module)configure().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={command};
