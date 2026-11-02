const {spawnSync}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
function cli(args){const result=spawnSync(process.execPath,['node_modules/supabase/dist/supabase.js',...args],{encoding:'utf8',windowsHide:true,maxBuffer:5*1024*1024});if(result.status!==0)throw new Error('No se pudo consultar Supabase con la sesión de CLI actual.');return result.stdout;}
(async()=>{
 const project='jyzqfethrgqqaaqzisqk';
 const raw=cli(['projects','api-keys','--project-ref',project,'--output','json']);
 const key=JSON.parse(raw.slice(raw.indexOf('['))).find(item=>item.name==='service_role')?.api_key;
 if(!key)throw new Error('No se encontró la credencial privada del proyecto.');
 const secrets=cli(['secrets','list','--project-ref',project,'--output','json']);
 if(!JSON.parse(secrets.slice(secrets.indexOf('['))).some(item=>item.name==='MIGAJAS_VERIFIER_SECRET'))throw new Error('Falta configurar la credencial compartida del verificador.');
 const client=createClient('https://'+project+'.supabase.co',key,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await client.storage.listBuckets();if(error)throw new Error('No se pudo comprobar el almacenamiento.');
 if(!data.some(bucket=>bucket.id==='migajas-launcher-updates')){
  const {error}=await client.storage.createBucket('migajas-launcher-updates',{public:false,fileSizeLimit:52428800,allowedMimeTypes:['application/octet-stream','application/x-msdownload','application/vnd.microsoft.portable-executable']});
  if(error)throw new Error('No se pudo crear el almacenamiento privado de actualizaciones.');
 }
 console.log('Almacenamiento privado de actualizaciones disponible. Verificador compartido configurado. No se mostraron claves.');
})().catch(error=>{console.error(error.message);process.exitCode=1});
