# SmartThings Bridge Scaffold

This folder contains the first working backend scaffold for a stable SmartThings integration without relying on 24-hour Personal Access Tokens.

## Why this exists

The direct Homey app approach using SmartThings PATs is not stable anymore because SmartThings PATs expire after 24 hours.

SmartThings' official long-lived integration paths require a cloud component:

- OAuth app registration
- SmartApp / webhook or equivalent public endpoint
- token exchange and refresh handling outside the local Homey app

This scaffold gives us a clean place to build that backend.

## What is included

- `GET /health`
- `GET /config`
- working OAuth endpoints:
  - `GET /oauth/start`
  - `GET /oauth/callback`
- session inspection:
  - `GET /sessions`
- SmartThings proxy endpoints:
  - `GET /smartthings/devices`
  - `GET /smartthings/devices/:deviceId/status`
  - `POST /smartthings/devices/:deviceId/commands`
- Homey-facing bridge endpoints:
  - `GET /homey/devices`
  - `POST /homey/robot/command`
- placeholder SmartThings webhook endpoint:
  - `POST /smartapp/webhook`

## Environment

Copy `.env.example` to `.env` and set:

- `PORT`
- `PUBLIC_BASE_URL`
- `SMARTTHINGS_CLIENT_ID`
- `SMARTTHINGS_CLIENT_SECRET`
- `HOMEY_SHARED_SECRET`

## Local run

```bash
npm install
npm run dev
```

Then open:

- `/health`
- `/config`
- `/oauth/start`

After SmartThings redirects back to `/oauth/callback`, the token is stored in `data/storage.json`.

## Deploy

### Render

This folder includes [render.yaml](/Users/lucaamoroso/Downloads/com.samsung-jet-bot-combo/smartthings-bridge/render.yaml) and a [Dockerfile](/Users/lucaamoroso/Downloads/com.samsung-jet-bot-combo/smartthings-bridge/Dockerfile).

Recommended setup:

1. Create a new Web Service on Render
2. Point it to this `smartthings-bridge` folder
3. Use Docker runtime
4. Set these environment variables:
   - `PUBLIC_BASE_URL`
   - `SMARTTHINGS_CLIENT_ID`
   - `SMARTTHINGS_CLIENT_SECRET`
   - `HOMEY_SHARED_SECRET`

### Railway

Railway can build directly from the [Dockerfile](/Users/lucaamoroso/Downloads/com.samsung-jet-bot-combo/smartthings-bridge/Dockerfile).

Recommended setup:

1. Create a new service from this `smartthings-bridge` folder
2. Let Railway detect the Dockerfile
3. Set these environment variables:
   - `PUBLIC_BASE_URL`
   - `SMARTTHINGS_CLIENT_ID`
   - `SMARTTHINGS_CLIENT_SECRET`
   - `HOMEY_SHARED_SECRET`

## What is still missing

This bridge still does **not** yet:

- implement SmartApp lifecycle handling
- persist storage in a production-grade database
- expose a finished Homey session management UX
- secure the bridge beyond the simple shared secret option
- update the Homey app to use the bridge instead of direct SmartThings access

## Recommended next implementation order

1. Deploy the bridge on a public HTTPS endpoint
2. Complete the SmartThings app registration with the bridge URLs
3. Verify OAuth login and token refresh end-to-end
4. Update the Homey app to use the bridge instead of direct SmartThings PAT access
5. Add webhook lifecycle handling only if SmartThings requires it for the chosen integration path
