// HTTP Basic Auth - 保護 admin 後台與 admin API
// 使用者名稱與密碼從 .env 讀取

import { timingSafeEqual } from "node:crypto";

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function requireAdminAuth(req, res) {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    // 沒設定密碼就直接放行 (開發階段)
    return true;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    sendChallenge(res);
    return false;
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const idx = decoded.indexOf(":");
  if (idx < 0) {
    sendChallenge(res);
    return false;
  }
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
    return true;
  }

  sendChallenge(res);
  return false;
}

function sendChallenge(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Hakuba Bot Admin"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("需要登入");
}
