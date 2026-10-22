const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const root = __dirname;
const types = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', types[path.extname(filePath)] || 'text/plain');
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('2048 server running at http://127.0.0.1:' + port));
