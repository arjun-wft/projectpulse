# Deploy Project Pulse on Render

This project uses one Node web service. The server keeps run state in memory and temporary workbooks on its local filesystem. No Redis or queue is used. A process restart clears active runs and any workbook that has not yet been downloaded.

## Deploy

1. Push this project to a private GitHub repository. Keep `.env`, `.runtime`, and `node_modules` out of Git; `.gitignore` covers these paths.
2. In Render, choose **New + > Blueprint**, connect the repository, and apply `render.yaml`.
3. In the service's Environment settings, set `GROQ_API_KEY` and `TWITTER_API_KEY`. Do not commit either secret.
4. Wait for the deploy. Check `https://<your-service>.onrender.com/health`; it should return JSON with `ok: true`.
5. Optionally create an UptimeRobot HTTP monitor for `https://<your-service>.onrender.com/health`. Configure it yourself if you want periodic pings; otherwise Render's free service can spin down after 15 minutes without traffic.

The Node server listens on Render's `PORT` and `0.0.0.0`. X searches run through `Scripts/twitter_search.js`, so the hosted service does not need PowerShell. Freelancer.com searches already run in Node.js.

## Current free-plan tradeoffs

- A free service may take about a minute to wake after it has spun down.
- A restart/redeploy can lose active job state and short-lived Excel files.
- Run only one search at a time; the app's lock is in process memory and is intended for a single service instance.
- Keep search result counts moderate. Each candidate is analyzed serially by Groq, so a large Freelancer campaign selection can take a while.

For regular team use, change `plan: free` in `render.yaml` to an always-on paid plan in Render. The app still needs a persistent disk if workbooks must survive a service restart; the current 5-minute cleanup behavior is temporary by design.
