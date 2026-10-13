# Deploy Project Pulse on Render

This project uses one Node web service. The server keeps run state in memory and temporary workbooks on its local filesystem. No Redis or queue is used. A process restart clears active runs and any workbook that has not yet been downloaded.

## Deploy

1. Push this project to a private GitHub repository. Keep `.env`, `.runtime`, and `node_modules` out of Git; `.gitignore` covers these paths.
2. In Render, choose **New + > Blueprint**, connect the repository, and apply `render.yaml`.
3. In the service's Environment settings, set `GROQ_API_KEY` and `TWITTER_API_KEY`. Do not commit either secret.
4. To email each finished spreadsheet, add `RESEND_API_KEY`, `LEADS_EMAIL_TO`, and `LEADS_EMAIL_FROM`. `LEADS_EMAIL_TO` can contain comma-separated addresses. The sender must be an address on a verified Resend domain. Leave all three unset to keep email disabled; a mail error does not discard the workbook.
5. Wait for the deploy. Check `https://<your-service>.onrender.com/health`; it should return JSON with `ok: true`.
6. Optionally create an UptimeRobot HTTP monitor for `https://<your-service>.onrender.com/health`. Configure it yourself if you want periodic pings; otherwise Render's free service can spin down after 15 minutes without traffic.

The Node server listens on Render's `PORT` and `0.0.0.0`. X searches run through `Scripts/twitter_search.js`, so the hosted service does not need PowerShell. Freelancer.com searches already run in Node.js.

## Current free-plan tradeoffs

- A free service may take about a minute to wake after it has spun down.
- A restart/redeploy can lose active job state and short-lived Excel files.
- Run only one search at a time; the app's lock is in process memory and is intended for a single service instance.
- Groq receives up to three records in one request. Requests stay serial and respect the configured spacing; oversized batches are split into smaller requests.
- Stop takes effect after the current external request/batch. The current workbook is checkpointed after every AI batch and remains downloadable for five minutes after the run stops or completes.
- Email delivery is optional and needs a Resend API key plus a verified sender domain. Configure those secrets in Render rather than committing them.

For regular team use, change `plan: free` in `render.yaml` to an always-on paid plan in Render. The app still needs a persistent disk if workbooks must survive a service restart; the current 5-minute cleanup behavior is temporary by design.
