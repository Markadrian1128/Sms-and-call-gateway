# Own SIM Gateway

This is the first self-owned gateway layer for the Collection website.

Flow:

```text
Collection website
  -> Supabase Edge Function
  -> Own SIM gateway server
  -> Android phone / SIM command
```

The server has three routes:

- `GET /health`
- `POST /sms`
- `POST /call`

It requires `Authorization: Bearer <GATEWAY_TOKEN>` for SMS and call requests.

## Safe Use

Use this only for legitimate CCFI collection contact workflows where the number belongs to an account record and your team is allowed to contact the borrower. Keep rate limits, audit logs, and user login checks enabled.

## Start in dry-run mode

```powershell
$env:GATEWAY_TOKEN="change-this-long-random-token"
$env:DRY_RUN="true"
node .\own-sim-gateway\server.js
```

Dry run checks the request, writes audit logs, but does not send SMS or start calls.

## Android / Termux command mode

Install these on the Android phone that has the SIM:

- Termux
- Termux:API

In Termux:

```sh
pkg update
pkg install nodejs termux-api
termux-setup-storage
```

Run the gateway on the phone:

```sh
export GATEWAY_TOKEN="change-this-long-random-token"
export DRY_RUN="false"
export SMS_COMMAND_JSON='["termux-sms-send","-n","{to}","{message}"]'
export CALL_COMMAND_JSON='["termux-telephony-call","{to}"]'
node server.js
```

For cloud access, expose the phone/server through a private tunnel such as Cloudflare Tunnel, Tailscale Funnel, or a secured reverse proxy. Do not expose it without HTTPS and a strong token.

## Test

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:8787/health"
```

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:8787/sms" `
  -Headers @{ Authorization = "Bearer change-this-long-random-token" } `
  -ContentType "application/json" `
  -Body '{"phoneNumber":"09171234567","message":"Test only","pn":"TEST-001"}'
```

## Notes About Calls

`/call` starts a cellular call from the SIM device. The actual voice audio stays on that phone unless you add separate call-center hardware/software. This is good for click-to-call or drop-call logging, but not yet a full browser-based voice dialer.
