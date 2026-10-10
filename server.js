// Minimal static server for local testing: `npm start` -> http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// Same behavior as GitHub Pages: unknown paths get 404.html.
function notFound(res) {
  fs.readFile(path.join(__dirname, "404.html"), (err, data) => {
    res.writeHead(404, { "Content-Type": "text/html" }).end(err ? "404" : data);
  });
}

http
  .createServer((req, res) => {
    const urlPath = new URL(req.url, "http://x").pathname;
    const file = path.join(__dirname, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(__dirname) || !TYPES[path.extname(file)] || file === __filename) {
      return notFound(res);
    }
    fs.readFile(file, (err, data) => {
      if (err) return notFound(res);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] }).end(data);
    });
  })
  .listen(PORT, () => console.log(`Abra http://localhost:${PORT}`));
