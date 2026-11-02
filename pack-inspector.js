const {unzipSync}=require('fflate');
exports.inspectPack=function(bytes){
 const entries=[];let manifestBytes;
 const content=unzipSync(bytes,{filter:file=>{entries.push(file.name);if(entries.length>50000)throw new Error('Demasiados archivos.');if(file.name==='modrinth.index.json'&&file.originalSize>2*1024*1024)throw new Error('Índice demasiado grande.');return file.name==='modrinth.index.json';}});manifestBytes=content['modrinth.index.json'];
 const normalized=entries.map(n=>n.replaceAll('\\','/'));
 const safe=name=>{if(!name||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.'||p.includes(':')))throw new Error('El paquete contiene rutas inseguras.');};normalized.filter(n=>!n.endsWith('/')).forEach(safe);
 if(normalized.some(n=>/(^|\/)(access_tokens|accounts|launcher_accounts)\.json$/i.test(n)||/\.(exe|bat|cmd|ps1)$/i.test(n)))throw new Error('El paquete contiene cuentas o ejecutables.');
 if(manifestBytes){
  const index=JSON.parse(new TextDecoder().decode(manifestBytes));if(index.formatVersion!==1||index.game!=='minecraft'||!Array.isArray(index.files)||!index.dependencies?.minecraft)throw new Error('El índice MRPACK no es válido.');
  if(index.dependencies['quilt-loader'])throw new Error('Este MRPACK requiere Quilt, que todavía no está soportado.');
  const loaders=[['fabric-loader','fabric'],['forge','forge'],['neoforge','neoforge']].filter(([key])=>index.dependencies[key]);if(loaders.length>1)throw new Error('El MRPACK define varios loaders.');
  for(const file of index.files){safe(file.path);if(!/^[a-f0-9]{40}$/i.test(file.hashes?.sha1||'')||!/^[a-f0-9]{128}$/i.test(file.hashes?.sha512||'')||!Array.isArray(file.downloads)||!file.downloads.length||!Number.isSafeInteger(file.fileSize)||file.fileSize<0)throw new Error('El MRPACK contiene un archivo inválido.');for(const value of file.downloads){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||!['cdn.modrinth.com','github.com','raw.githubusercontent.com','gitlab.com','objects.githubusercontent.com','release-assets.githubusercontent.com'].includes(url.hostname))throw new Error('El MRPACK contiene un origen de descarga no autorizado.');}}
  return {format:'mrpack',files:entries.length,mods:index.files.filter(f=>f.env?.client!=='unsupported'&&/^mods\/.+\.jar$/i.test(f.path)).length,runtime:{version_mc:index.dependencies.minecraft,tipo_loader:loaders[0]?.[1]||'vanilla',loader_version:loaders.length?index.dependencies[loaders[0][0]]:''},name:index.name};
 }
 const mods=normalized.filter(n=>/(^|\/)mods\/.+\.jar(?:\.disabled)?$/i.test(n));if(!mods.length)throw new Error('No encuentro mods. Incluye una carpeta mods con sus .jar o un MRPACK válido.');return {format:'zip',mods:mods.length,files:entries.length};
};
