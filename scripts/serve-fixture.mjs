import path from 'node:path';
import { startFixtureServer } from '../test/helpers/fixture-server.mjs';

const args = process.argv.slice(2);
let dir = 'fixtures/good';
let port = 0;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--port') {
    index += 1;
    port = Number(args[index]);
  } else if (!args[index].startsWith('-')) {
    dir = args[index];
  }
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Error: --port must be a valid port number');
  process.exit(2);
}

const fixture = await startFixtureServer(path.resolve(dir), { port });
console.log(fixture.baseUrl);

const shutdown = async () => {
  await fixture.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
