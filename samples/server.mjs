// Local test server for LitePostman: `node samples/server.mjs` → http://localhost:4567
import http from "node:http";

const PORT = Number(process.env.PORT) || 4567;
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = url.pathname;
      const auth = req.headers.authorization ?? "";
      if (p === "/users") return json(res, 200, { page: Number(url.searchParams.get("page") ?? 1), users: [{ id: 1, name: "Abebe" }, { id: 2, name: "Sara" }] });
      if (p.startsWith("/users/")) return json(res, 200, { id: Number(p.split("/")[2]), name: "Abebe" });
      if (p === "/echo") return json(res, 200, { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (p === "/login") {
        const b = JSON.parse(body || "{}");
        return b.username === "eyoel" && b.password === "pass" ? json(res, 200, { token: "secret-token" }) : json(res, 401, { error: "bad credentials" });
      }
      if (p === "/auth/bearer") return auth === "Bearer secret-token" ? json(res, 200, { ok: true }) : json(res, 401, { error: "missing/invalid bearer", got: auth });
      if (p === "/auth/basic") return auth === "Basic " + Buffer.from("eyoel:pass").toString("base64") ? json(res, 200, { ok: true }) : json(res, 401, { error: "bad basic", got: auth });
      if (p === "/auth/apikey") return req.headers["x-api-key"] === "k-123" || url.searchParams.get("api_key") === "k-123" ? json(res, 200, { ok: true }) : json(res, 401, { error: "bad api key" });
      if (p === "/slow") return setTimeout(() => json(res, 200, { waited: Number(url.searchParams.get("ms") ?? 3000) }), Number(url.searchParams.get("ms") ?? 3000));
      if (p === "/redirect") {
        res.writeHead(302, { Location: "/users?page=9" });
        return res.end();
      }
      if (p === "/big") return json(res, 200, { items: Array.from({ length: 40000 }, (_, i) => ({ id: i, name: `item number ${i}`, tags: ["a", "b", "c"], nested: { x: i * 2, y: "lorem ipsum dolor" } })) });
      if (p === "/xml") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        return res.end('<?xml version="1.0"?><users><user id="1">Abebe</user><user id="2">Sara</user></users>');
      }
      if (p === "/html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<!doctype html><html><body><h1>Hello</h1></body></html>");
      }
      if (p === "/cookie/set") return json(res, 200, { set: true }, { "Set-Cookie": "session=abc123; Path=/" });
      if (p === "/cookie/get") return json(res, 200, { cookie: req.headers.cookie ?? null });
      json(res, 404, { error: "not found", path: p });
    });
  })
  .listen(PORT, () => console.log(`test server on http://localhost:${PORT}`));
