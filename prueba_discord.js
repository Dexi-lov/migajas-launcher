const RPC = require('discord-rpc');
const clientId = '1411570545190899822';

const client = new RPC.Client({ transport: 'ipc' });

console.log("1. Intentando conectar con Discord...");

client.on('ready', () => {
    console.log('2. ¡ÉXITO! Conectado a Discord.');
    console.log('3. Usuario detectado:', client.user.username);
    
    client.setActivity({
        details: 'Haciendo Pruebas',
        state: 'Verificando ID',
        startTimestamp: new Date(),
        instance: false,
    });
    
    console.log('4. Estado enviado. Mira tu perfil de Discord ahora.');
});

client.login({ clientId }).catch((err) => {
    console.error('!!! ERROR DE CONEXIÓN !!!');
    console.error(err);
});