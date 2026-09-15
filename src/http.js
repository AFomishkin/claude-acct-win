"use strict";
// One tiny HTTPS client for the whole port: no curl and no dependencies.

const https = require("https");
const { URL } = require("url");

// request(url, {method, headers, body, timeoutMs}) -> {status, body}
// A network failure or a timeout arrives as a reject with the code "unreachable".
function request(url, { method = "GET", headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "unreachable" }));
    });
    req.on("error", (e) => {
      reject(Object.assign(e, { code: "unreachable" }));
    });
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { request, json };
