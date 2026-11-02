import releases from '../../release-notes.json';

type Env = {DISCORD_APPLICATION_ID:string; DISCORD_PUBLIC_KEY:string; DISCORD_GUILD_ID:string};
const encoder = new TextEncoder();
const hex = (value:string) => Uint8Array.from(value.match(/../g) || [], part=>parseInt(part,16));
const reply = (data:Record<string,unknown>, privateReply=false) => Response.json({type:4,data:{...data,allowed_mentions:{parse:[]},...(privateReply?{flags:64}:{})}});
const button = (label:string,url:string) => ({type:2,style:5,label,url});
const links = [{type:1,components:[button('Descargar launcher','https://github.com/Dexi-lov/migajas-launcher/releases/latest'),button('Comunidad','https://discord.gg/eGxXWesV4J')]}];
const help:Record<string,string> = {
  jugar:'Abre Migajas Launcher, inicia sesión y elige un evento. Pulsa Jugar: la primera vez descargará lo necesario. Espera hasta que se abra Minecraft y deja el launcher abierto.',
  skin:'Abre el menú de tu perfil en el launcher y entra en el apartado de tu skin. Selecciona tu imagen y guarda el cambio. La cara de tu personaje se actualizará en el launcher.',
  ram:'Abre los ajustes del launcher y busca Memoria RAM. Asigna una cantidad que tu computadora pueda ofrecer sin quedarse sin memoria para el resto de programas.',
  controles:'Haz clic derecho sobre un evento y entra en Configuración de instancia. Puedes ajustar controles, sensibilidad, FOV, volumen, gráficos y paquetes de recursos.',
  amigos:'Pulsa el botón de Amigos del launcher y busca el nombre de la otra persona. Envía una solicitud y espera a que la acepte. Desde ahí podrás ver su actividad y el evento que está jugando.',
  borrar:'Haz clic derecho sobre la instancia y elige Eliminar. Revisa bien la confirmación: se borrarán sus datos locales, incluidos mundos y configuraciones de esa instancia.',
  soporte:'Si algo falla, explica qué estabas haciendo y copia el error en el canal de ayuda de Migajas Studio. Nunca compartas contraseñas, códigos del autenticador ni archivos de claves.'
};
export default {
 async fetch(request:Request,env:Env):Promise<Response> {
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/health')return Response.json({name:'Migi',status:'ready',version:releases.releases[0].version});
  if(request.method!=='POST'||path!=='/interactions')return new Response('Not found',{status:404});
  const signature=request.headers.get('x-signature-ed25519')||'',timestamp=request.headers.get('x-signature-timestamp')||'';
  if(!/^[a-f0-9]{128}$/i.test(signature)||!/^\d{10,12}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300)return new Response('Invalid signature',{status:401});
  if(Number(request.headers.get('content-length')||0)>32768)return new Response('Too large',{status:413});
  const raw=await request.text();if(raw.length>32768)return new Response('Too large',{status:413});
  try {
   const key=await crypto.subtle.importKey('raw',hex(env.DISCORD_PUBLIC_KEY),{name:'Ed25519'},false,['verify']);
   if(!await crypto.subtle.verify('Ed25519',key,hex(signature),encoder.encode(timestamp+raw)))return new Response('Invalid signature',{status:401});
  } catch {return new Response('Invalid signature',{status:401});}
  let input:any;try{input=JSON.parse(raw);}catch{return new Response('Invalid JSON',{status:400});}
  if(input.application_id!==env.DISCORD_APPLICATION_ID)return new Response('Wrong application',{status:403});
  if(input.type===1)return Response.json({type:1});
  if(input.guild_id!==env.DISCORD_GUILD_ID)return reply({content:'Migi está disponible en el servidor de Migajas Studio.'},true);
  if(input.type!==2||input.data?.name!=='migi')return reply({content:'Utiliza /migi para hablar conmigo.'},true);
  const option=input.data.options?.[0];
  if(option?.name==='bienvenida'){
   let permissions=0n;try{permissions=BigInt(input.member?.permissions||'0');}catch{}
   if((permissions&32n)===0n&&(permissions&8n)===0n)return reply({content:'Este anuncio lo publica el equipo con permiso Administrar servidor.'},true);
   const welcome=releases.eraWelcome;
   return reply({embeds:[{title:'🕊️ '+welcome.title,color:0xe83f52,description:welcome.summary,fields:welcome.sections.map(section=>({name:section.title,value:section.items.map(text=>'• '+text).join('\n')})),footer:{text:'Gracias por formar parte de Migajas Studio. ¡Vamos a por nuestras migajas!'}}],components:links});
  }
  if(option?.name==='novedades'){
   const release=releases.releases[0];
   const fields=[{name:'Cosas nuevas',value:release.new.map(text=>'• '+text).join('\n')},{name:'Más cómodo para ti',value:release.improved.map(text=>'• '+text).join('\n')}].filter(field=>field.value).map(field=>({...field,value:field.value.slice(0,1000)}));
   return reply({embeds:[{title:'🕊️ Migi te cuenta · '+release.version,color:0xe83f52,description:release.summary.slice(0,3500),...(fields.length?{fields}:{})}],components:links});
  }
  const topic=option?.options?.find((item:any)=>item.name==='tema')?.value;
  return reply({embeds:[{title:'🕊️ Estoy aquí para ayudarte',color:0xe83f52,description:help[topic]||'¡Prrú! Solo respondo preguntas del launcher. Usa **/migi ayuda** y elige jugar, skin, ram, controles, amigos, borrar o soporte. También puedo enseñarte las novedades con **/migi novedades**.'}],components:links},true);
 }
};
