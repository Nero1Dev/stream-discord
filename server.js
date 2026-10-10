// Minimal static server for local testing: `npm start` -> http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http
  .createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    const file = path.join(__dirname, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(__dirname) || !TYPES[path.extname(file)] || file === __filename) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] }).end(data);
    });
  })
  .listen(PORT, () => console.log(`Abra http://localhost:${PORT}`));
