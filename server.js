import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const app = express();

app.use(express.json({ limit: '1mb' }));

const port = Number(process.env.PORT || 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const callbackUrl = `${publicBaseUrl}/oauth/callback`;
const webhookUrl = `${publicBaseUrl}/smartapp/webhook`;
const tokenUrl = 'https://auth-global.api.smartthings.com/oauth/token';
const authorizeUrl = 'https://api.smartthings.com/oauth/authorize';
const scopes = ['r:devices:*', 'w:devices:*', 'x:devices:*'];

const dataDir = path.join(process.cwd(), 'data');
const storagePath = path.join(dataDir, 'storage.json');
const defaultSessionId = 'default';

let storage = {
  oauthStates: {},
  sessions: {},
};

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function loadStorage() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(storagePath, 'utf8');
    storage = { ...storage, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function saveStorage() {
  await ensureDataDir();
  await fs.writeFile(storagePath, JSON.stringify(storage, null, 2));
}

function summary() {
  return {
    publicBaseUrl,
    callbackUrl,
    webhookUrl,
    smartThingsClientIdConfigured: Boolean(process.env.SMARTTHINGS_CLIENT_ID),
    smartThingsClientSecretConfigured: Boolean(process.env.SMARTTHINGS_CLIENT_SECRET),
    homeySharedSecretConfigured: Boolean(process.env.HOMEY_SHARED_SECRET),
    sessionsConfigured: Object.keys(storage.sessions || {}).length,
  };
}

function requireOAuthConfig() {
  if (!process.env.SMARTTHINGS_CLIENT_ID || !process.env.SMARTTHINGS_CLIENT_SECRET) {
    const err = new Error('Missing SMARTTHINGS_CLIENT_ID or SMARTTHINGS_CLIENT_SECRET');
    err.status = 500;
    throw err;
  }
}

function randomId(size = 24) {
  return crypto.randomBytes(size).toString('hex');
}

function sessionRecord(sessionId = defaultSessionId) {
  return storage.sessions[sessionId] || null;
}

function expiresAtFromToken(token) {
  const expiresIn = Number(token.expires_in || 0);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }

  return Date.now() + expiresIn * 1000;
}

function normalizeTokenResponse(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token || null,
    token_type: token.token_type || 'bearer',
    expires_in: token.expires_in || null,
    scope: token.scope || null,
    expires_at: expiresAtFromToken(token),
  };
}

async function exchangeToken({ grantType, params }) {
  requireOAuthConfig();

  const body = new URLSearchParams();
  body.set('grant_type', grantType);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) {
      body.set(key, value);
    }
  }

  const auth = Buffer.from(
    `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`,
  ).toString('base64');

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error_description
      || payload?.message
      || `Token exchange failed with ${response.status}`,
    );
    error.status = response.status;
    error.details = payload || text;
    throw error;
  }

  return normalizeTokenResponse(payload || {});
}

async function saveSessionToken(sessionId, token) {
  storage.sessions[sessionId] = {
    ...(storage.sessions[sessionId] || {}),
    token,
    updated_at: new Date().toISOString(),
  };
  await saveStorage();
  return storage.sessions[sessionId];
}

async function refreshSession(sessionId = defaultSessionId) {
  const session = sessionRecord(sessionId);
  const refreshToken = session?.token?.refresh_token;
  if (!refreshToken) {
    const err = new Error('Missing refresh token');
    err.status = 401;
    throw err;
  }

  const refreshed = await exchangeToken({
    grantType: 'refresh_token',
    params: {
      refresh_token: refreshToken,
    },
  });

  if (!refreshed.refresh_token) {
    refreshed.refresh_token = refreshToken;
  }

  return saveSessionToken(sessionId, refreshed);
}

function accessTokenExpiresSoon(token) {
  if (!token?.expires_at) {
    return false;
  }

  return Date.now() >= token.expires_at - 60_000;
}

async function getValidAccessToken(sessionId = defaultSessionId) {
  const session = sessionRecord(sessionId);
  if (!session?.token?.access_token) {
    const err = new Error('Missing SmartThings session');
    err.status = 401;
    throw err;
  }

  if (accessTokenExpiresSoon(session.token) && session.token.refresh_token) {
    const refreshed = await refreshSession(sessionId);
    return refreshed.token.access_token;
  }

  return session.token.access_token;
}

async function smartThingsRequest({ sessionId = defaultSessionId, path: requestPath, method = 'GET', json }) {
  const attempt = async (accessToken) => {
    const response = await fetch(`https://api.smartthings.com/v1${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.smartthings+json;v=1',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    return { response, payload };
  };

  let accessToken = await getValidAccessToken(sessionId);
  let { response, payload } = await attempt(accessToken);

  if (response.status === 401) {
    accessToken = (await refreshSession(sessionId)).token.access_token;
    ({ response, payload } = await attempt(accessToken));
  }

  if (!response.ok) {
    const err = new Error(
      payload?.message
      || payload?.error_description
      || `SmartThings request failed with ${response.status}`,
    );
    err.status = response.status;
    err.details = payload;
    throw err;
  }

  return payload;
}

function requireHomeyAuth(req) {
  const sharedSecret = process.env.HOMEY_SHARED_SECRET;
  if (!sharedSecret) {
    return;
  }

  const authorization = String(req.get('authorization') || '');
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (bearer !== sharedSecret) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

function sendError(res, err) {
  res.status(err.status || 500).json({
    ok: false,
    error: err.message,
    details: err.details || null,
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'smartthings-bridge',
    ...summary(),
  });
});

app.get('/config', (req, res) => {
  res.json({
    oauthAuthorizeUrl: authorizeUrl,
    oauthTokenUrl: tokenUrl,
    callbackUrl,
    webhookUrl,
    scopes,
    ...summary(),
  });
});

app.get('/oauth/start', async (req, res) => {
  try {
    requireOAuthConfig();
    const sessionId = String(req.query.session || defaultSessionId);
    const state = randomId(18);

    storage.oauthStates[state] = {
      sessionId,
      created_at: Date.now(),
    };
    await saveStorage();

    const url = new URL(authorizeUrl);
    url.searchParams.set('client_id', process.env.SMARTTHINGS_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state || !storage.oauthStates[state]) {
      const err = new Error('Invalid OAuth callback state');
      err.status = 400;
      throw err;
    }

    const { sessionId } = storage.oauthStates[state];
    delete storage.oauthStates[state];

    const token = await exchangeToken({
      grantType: 'authorization_code',
      params: {
        code,
        redirect_uri: callbackUrl,
      },
    });

    await saveSessionToken(sessionId, token);
    await saveStorage();

    res.type('html').send(`
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px;">
          <h1>SmartThings connected</h1>
          <p>Session <strong>${sessionId}</strong> saved successfully.</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/sessions', (req, res) => {
  res.json({
    ok: true,
    sessions: Object.fromEntries(
      Object.entries(storage.sessions).map(([sessionId, session]) => [
        sessionId,
        {
          hasAccessToken: Boolean(session?.token?.access_token),
          hasRefreshToken: Boolean(session?.token?.refresh_token),
          expiresAt: session?.token?.expires_at || null,
          updatedAt: session?.updated_at || null,
        },
      ]),
    ),
  });
});

app.get('/smartthings/devices', async (req, res) => {
  try {
    const sessionId = String(req.query.session || defaultSessionId);
    const payload = await smartThingsRequest({
      sessionId,
      path: '/devices',
    });
    res.json({
      ok: true,
      sessionId,
      items: payload?.items || [],
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/smartthings/devices/:deviceId/status', async (req, res) => {
  try {
    const sessionId = String(req.query.session || defaultSessionId);
    const payload = await smartThingsRequest({
      sessionId,
      path: `/devices/${req.params.deviceId}/status`,
    });
    res.json({
      ok: true,
      sessionId,
      status: payload,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/smartthings/devices/:deviceId/commands', async (req, res) => {
  try {
    const sessionId = String(req.query.session || defaultSessionId);
    const payload = await smartThingsRequest({
      sessionId,
      method: 'POST',
      path: `/devices/${req.params.deviceId}/commands`,
      json: req.body,
    });
    res.json({
      ok: true,
      sessionId,
      result: payload,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/smartapp/webhook', async (req, res) => {
  try {
    const lifecycle = req.body?.lifecycle
      || req.body?.messageType
      || req.body?.headers?.interactionType
      || 'unknown';
    console.log('[smartapp/webhook] lifecycle=%s body=%j', lifecycle, req.body);

    if (lifecycle === 'PING') {
      const challenge = req.body?.pingData?.challenge;
      if (!challenge) {
        const err = new Error('Missing ping challenge');
        err.status = 400;
        throw err;
      }

      return res.json({
        pingData: {
          challenge,
        },
      });
    }

    if (lifecycle === 'CONFIRMATION') {
      const confirmationUrl = req.body?.confirmationData?.confirmationUrl;
      if (!confirmationUrl) {
        const err = new Error('Missing confirmationUrl');
        err.status = 400;
        throw err;
      }

      console.log('[smartapp/webhook] confirmationUrl=%s', confirmationUrl);

      const confirmResponse = await fetch(confirmationUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      const confirmText = await confirmResponse.text();
      console.log(
        '[smartapp/webhook] confirmation GET status=%s body=%s',
        confirmResponse.status,
        confirmText,
      );
      if (!confirmResponse.ok) {
        const err = new Error(`Confirmation GET failed with ${confirmResponse.status}`);
        err.status = confirmResponse.status;
        err.details = confirmText;
        throw err;
      }

      return res.json({
        targetUrl: webhookUrl,
      });
    }

    return res.json({
      ok: true,
      lifecycle,
    });
  } catch (err) {
    console.error('[smartapp/webhook] error', err);
    sendError(res, err);
  }
});

app.get('/homey/devices', async (req, res) => {
  try {
    requireHomeyAuth(req);
    const sessionId = String(req.query.session || defaultSessionId);
    const payload = await smartThingsRequest({
      sessionId,
      path: '/devices',
    });
    const items = (payload?.items || []).filter(device => {
      const text = [
        device.deviceTypeName,
        device.label,
        device.name,
        device.presentationId,
        device.ocf?.ocfDeviceType,
        device.ocf?.modelNumber,
      ].filter(Boolean).join(' ').toLowerCase();

      return /robotcleaner|robot cleaner|robot vacuum|jetbot|aspirapolvere|lavapav|samsungce\.robotcleaner/u.test(text);
    });

    res.json({
      ok: true,
      sessionId,
      items,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/homey/robot/command', async (req, res) => {
  try {
    requireHomeyAuth(req);
    const sessionId = String(req.body?.session || defaultSessionId);
    const deviceId = String(req.body?.deviceId || '');
    const commands = req.body?.commands;

    if (!deviceId || !Array.isArray(commands) || !commands.length) {
      const err = new Error('deviceId and commands[] are required');
      err.status = 400;
      throw err;
    }

    const payload = await smartThingsRequest({
      sessionId,
      method: 'POST',
      path: `/devices/${deviceId}/commands`,
      json: { commands },
    });

    res.json({
      ok: true,
      sessionId,
      result: payload,
    });
  } catch (err) {
    sendError(res, err);
  }
});

await loadStorage();

app.listen(port, () => {
  console.log(`smartthings-bridge listening on ${publicBaseUrl}`);
});
