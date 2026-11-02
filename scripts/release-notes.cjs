const fs = require('node:fs'), path = require('node:path');
function releaseBody(data, version) {
  const release = data.releases.find(entry => entry.version === version);
  if (!release || !release.summary?.trim()) {
    throw new Error('Faltan las novedades de ' + version + ' en release-notes.json. Escríbelas con palabras sencillas para los jugadores.');
  }
  let body = release.summary;
  for (const [key, title] of [['new', 'Cosas nuevas'], ['improved', 'Mejoras'], ['fixed', 'Problemas arreglados']]) {
    if (release[key]?.length) body += '\n\n### ' + title + '\n' + release[key].map(line => '- ' + line).join('\n');
  }
  return body;
}
module.exports = { releaseBody };
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const body = releaseBody(JSON.parse(fs.readFileSync(path.join(root, 'release-notes.json'), 'utf8')), require(path.join(root, 'package.json')).version);
    if (process.argv.includes('--github-output')) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('No se encontró la salida de GitHub Actions.');
      const delimiter = 'NOTES_' + require('node:crypto').randomUUID();
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`);
    } else process.stdout.write(body + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
