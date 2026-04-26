# LensDesk — Remote Camera Tech Support

Zero-install WebRTC camera sessions. Tech generates a one-time link → user taps on phone → live rear camera appears in tech dashboard. Works even when the user's PC is completely broken.

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser (tech dashboard).

## How it works

1. Tech opens the dashboard, clicks **Generate link**
2. System creates a one-time token URL (e.g. `http://localhost:3000/join/abc123...`)
3. Tech sends the link via SMS or email from the dashboard
4. User taps the link on their phone → sees a consent screen → taps Allow
5. Rear camera streams live to the tech's browser via WebRTC peer-to-peer
6. Session ends when either party clicks End, or TTL expires

## Architecture

```
Tech's browser  ←──WebRTC P2P──→  User's phone
        ↕                                ↕
    WebSocket signaling server (Node.js)
              ↕
    In-memory token store (TTL auto-expiry)
```

The video stream is **peer-to-peer** — it never touches the server. Only the WebRTC signaling (offer/answer/ICE candidates) passes through the server.

## Files

```
server.js          — HTTP + WebSocket signaling server
public/
  tech.html        — Tech dashboard (session management + video feed)
  user.html        — User camera page (consent + stream sender)
```

## Production checklist

- [ ] **HTTPS** — Required for `getUserMedia` on mobile. Use a reverse proxy (nginx + certbot) or deploy to Vercel/Railway with automatic TLS.
- [ ] **BASE_URL** env var — Set to your public domain: `BASE_URL=https://yourdomain.com node server.js`
- [ ] **TURN server** — Add Twilio Network Traversal credentials for users behind strict NAT:
  ```js
  // In both tech.html and user.html, replace STUN with:
  const iceServers = [{
    urls: 'turn:global.turn.twilio.com:3478',
    username: 'YOUR_TWILIO_TURN_USERNAME',
    credential: 'YOUR_TWILIO_TURN_PASSWORD',
  }];
  ```
- [ ] **Redis** — Replace the in-memory `sessions` Map with Upstash Redis for multi-instance deployments
- [ ] **Auth** — Add login to the tech dashboard so only your team can create sessions
- [ ] **SMS/Email** — Configure Twilio and SendGrid API keys for one-click link sending

## Environment variables

| Variable             | Default                  | Description                          |
|----------------------|--------------------------|---------------------------------------|
| `PORT`               | `3000`                   | HTTP + WebSocket port                 |
| `BASE_URL`           | `http://localhost:3000`  | Public URL for generated links        |
| `ANTHROPIC_API_KEY`  | *(required for Vision AI)* | Your Anthropic API key — never expose this client-side |
| `ANTHROPIC_VISION_MODEL` | `claude-sonnet-4-20250514` | Optional Vision AI model override |

## Quick start

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Get your API key at: https://console.anthropic.com

## Vision AI response contract

`POST /api/ai/analyze` returns a normalized support object:

```json
{
  "confidence": 0.87,
  "observations": ["Router is powered on"],
  "possibleIssue": "ISP connectivity issue or WAN cable problem",
  "recommendedNextSteps": ["Check WAN/fiber connection"]
}
```

The technician panel renders this as a structured card with copy-to-clipboard and optional Zendesk internal-note actions.

## Extending

- **Annotation overlay** — Draw on the video feed using a `<canvas>` overlay with pointer events, sync strokes via WebSocket
- **Two-way audio** — Already included in the WebRTC offer (`audio: true`) — just add playback on the user side
- **Session recording** — Use `MediaRecorder` on the tech side to record the incoming stream
- **Screenshot** — Already implemented: click the camera icon in the toolbar
