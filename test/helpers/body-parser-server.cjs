// Isolated because the vulnerable parser can terminate the whole process.
const http = require('node:http');
const parser = require(process.argv[2]).json();
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.end('healthy');
    return;
  }
  parser(req, res, error => {
    res.statusCode = error ? error.status || 400 : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(error ? { error: error.type } : req.body));
  });
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
