import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

export async function startFixtureServer(dir, { cors = true, onRequest, port = 0, host = '127.0.0.1' } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    onRequest?.(req);
    const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.resolve(root, '.' + pathname);
    const headers = {};
    if (cors) headers['access-control-allow-origin'] = '*';
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(404, headers);
      res.end('not found');
      return;
    }
    try {
      const body = await readFile(filePath);
      headers['content-type'] = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, headers);
      res.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    baseUrl: `http://${host}:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
