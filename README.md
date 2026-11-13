# Error Monitor

Reads the live and beta GChat error groups, counts and groups the alerts, explains why they happen, and on request asks Claude to read the failing code and propose a fix.

```
GChat error groups ──(Google Chat API, your account)──► sync every minute ──► data/state.json
        ▲                                                       │
        └──── Error Monitor bot replies in the alert thread ◄───┘ (owner, team, fix prompt)
                                                                                │
                                   dashboard (http://localhost:4600) ◄──────────┤
                                   "Ask Claude for a fix" ──► finds the function in REPO_DIRS ──► Claude API
```

- **Alerts** are the messages posted by `@adittech/logger-nest`. Each one is de-duplicated by Error ID.
- **Issues** group alerts from the same function with the same error message (IDs and numbers are ignored).
- **Why / How to fix** comes from built-in rules (EHR timeout, null bug, 5xx and so on) at no cost. **Ask Claude** is on demand, runs once per issue, and the answer is cached.
- Only bot or webhook messages are counted. People replying in threads are only read for bot requests (`fix`, `reply`, @mention).

## One-time setup (about 10 minutes)

1. **Google Cloud project.** Go to <https://console.cloud.google.com> and create a project under the adit.com organization.
2. **Turn on the Chat API.** Go to APIs & Services, then Library, and enable **Google Chat API**.
3. **Configure the Chat app.** Open Google Chat API, then **Configuration**. Enter an app name (e.g. "Error Monitor"), an avatar URL and a description, then save. Google requires this even though we only read messages. You can leave the interactive features off.
4. **OAuth consent screen.** Set User type to **Internal** and add these scopes:
   - `https://www.googleapis.com/auth/chat.spaces.readonly`
   - `https://www.googleapis.com/auth/chat.messages.readonly`
   - `https://www.googleapis.com/auth/chat.memberships.readonly` (lets the bot turn an owner's email into an @mention)
5. **OAuth client.** Go to Credentials, then Create credentials, then OAuth client ID, and choose **Web application**. Under Authorized redirect URIs, add `http://localhost:4600/auth/google/callback`.
6. **Get the group IDs.** Open each error group in the browser. The ID is the end of the URL: `chat.google.com/room/AAQA4jC2Ac0` gives `AAQA4jC2Ac0`.
7. Copy `.env.example` to `.env` and fill it in.
8. Run:
   ```
   npm install
   npm start
   ```
   Open <http://localhost:4600>, click **Connect Google**, and sign in with an account that is a member of every group.

If Google shows "access blocked" at sign-in, your Workspace admin restricts third-party apps. Ask them to trust the app's OAuth client ID.

## Error Monitor bot (optional)

On the first alert of an issue each day, the bot replies in that alert's thread:

```
@Ravi Patel The practice's EHR bridge didn't answer in time while running fetchTreatmentCodesForLocation.
Responsible Team: Tx Plan
Request a Fix or Reply: reply in this thread with `fix` for a fix prompt, `reply` for a message to the team, or @mention me with a question.
```

- **Owners** come from **Teams and owners** on the dashboard: a team, its owner's name and Google email, and keywords. The first team whose keyword appears in the alert's module, error type, title or message wins. With no match, the team is named automatically, e.g. "EHR issue", "DB connection issue" or "Setting issue", and no one is tagged.
- **Thread replies** are checked on every sync. `fix` gets a short prompt to paste into Claude Code, `reply` gets a message for the team or support, and any message that @mentions the bot gets an answer. Everything else is left alone. Answers take one to two minutes and also show on the issue card.
- It only posts for alerts less than an hour old, so the first sync doesn't flood old threads, and only in `BOT_SPACES`.

Setup, in the same Google Cloud project:

1. **Chat API → Configuration:** turn **Interactive features** on and tick **Join spaces and group conversations**. Under Visibility, add the people or groups who may add the app.
2. **Connection settings:** choose **Cloud Pub/Sub**. Create a Pub/Sub topic (e.g. `error-monitor-events`), give `chat-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it, and enter `projects/<project-id>/topics/error-monitor-events`. The bot doesn't read this topic. It's there because Google requires a connection and a topic needs no public URL.
3. **Service account:** go to IAM & Admin, then Service accounts, and create `error-monitor-bot`. It needs no roles. Under Keys, add a JSON key and save it as `data/bot-key.json`. If key creation is blocked, your admin has the `iam.disableServiceAccountKeyCreation` policy on.
4. In each group: open the group menu, then **Apps & integrations**, then **Add apps**, and choose **Error Monitor**. If it isn't listed, your Workspace admin has to allow internal Chat apps.
5. In `.env`, set `BOT_KEY_FILE=data/bot-key.json` and `BOT_SPACES=<test group ID>`. Restart, then click **Connect Google** again so the new memberships scope is granted.
6. **Instant answers and DMs (recommended):** in Pub/Sub, open the topic's subscription (e.g. `error-monitor-events-sub`), go to **Permissions**, and give the bot's service account the **Pub/Sub Subscriber** role. Set `PUBSUB_SUBSCRIPTION=projects/<project-id>/subscriptions/error-monitor-events-sub`. Without it, the bot can't hear DMs, and Google shows "not responding" on @mentions because the answer only comes with the next sync.

**DMs:** anyone who opens a chat with Error Monitor gets a DM with a link each time they're tagged in a bot group, and can ask it things like "links of the errors I'm tagged in" or "what broke today?".

## Sharing with the team

Run it on a shared machine with `HOST=0.0.0.0` and a `DASH_PASSWORD`. Put it behind HTTPS, since Basic auth sends the password in every request. Add the new callback URL to the OAuth client and set `GOOGLE_REDIRECT_URI` to match. The server refuses to start on a non-local host without a password.

## Good to know

- **Which Claude:** if `ANTHROPIC_API_KEY` is empty, "Ask Claude" runs your logged-in `claude` CLI on this machine, with read-only access to `REPO_DIRS` and no web or shell, so it can search the repos itself. With a key set, it calls the Claude API instead. On a shared server, use a key rather than one person's login.
- **Data sent to Claude:** for the issue you click, up to 3 sample alerts (payload IDs included) plus the source of the failing function are sent to the Anthropic API.
- **Cost:** each "Ask Claude" is one Claude Opus 5.5 call, usually a few cents. Answers are cached per issue, and "Ask again" re-runs.
- **Storage:** `data/state.json` holds the alerts and the Google refresh token. Keep it private (it is already in `.gitignore`).
- **Tests:** `npm test`.
