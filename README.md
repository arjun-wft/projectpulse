# Project Pulse: Real-Time B2B Lead Generation & AI Classification Engine

Project Pulse is an automated, real-time lead generation engine that scrapes client buyer requests from **Freelancer.com** and **Twitter / X**, passes them through **Groq LLM (openai/gpt-oss-120b)** for high-precision buyer-intent classification, and generates structured, downloadable Excel workbooks with dual data streams.

---

## Table of Contents
1. [High-Level Architecture](#high-level-architecture)
2. [End-to-End System Workflow](#end-to-end-system-workflow)
3. [Core Subsystems](#core-subsystems)
   - [1. Authentication & Security Engine](#1-authentication--security-engine)
   - [2. Multi-Source Lead Scrapers](#2-multi-source-lead-scrapers)
   - [3. Dual Download Pipeline](#3-dual-download-pipeline)
   - [4. Groq AI Classification & Intelligent Rate Pacer](#4-groq-ai-classification--intelligent-rate-pacer)
   - [5. Email Dispatcher](#5-email-dispatcher)
   - [6. Frontend Dashboard & Real-Time Monitoring](#6-frontend-dashboard--real-time-monitoring)
4. [Data Schemas & Excel Exports](#data-schemas--excel-exports)
5. [API Endpoint Reference](#api-endpoint-reference)
6. [Environment Variables](#environment-variables)
7. [Local Setup & Testing](#local-setup--testing)
8. [Production Deployment (Render.com)](#production-deployment-rendercom)

---

## High-Level Architecture

```
                    ┌─────────────────────────┐
                    │      Client Browser     │
                    │  (Dashboard / Login UI) │
                    └────────────┬────────────┘
                                 │ HTTP / JSON
                                 ▼
                    ┌─────────────────────────┐
                    │   Node.js Web Server    │
                    │      (server.js)        │
                    │  ┌───────────────────┐  │
                    │  │ Auth & Rate Limit │  │
                    │  │ (20 login req/min)│  │
                    │  └───────────────────┘  │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌─────────────────────────┐                     ┌─────────────────────────┐
│  Freelancer.com API     │                     │    TwitterAPI.io        │
│ (Active Projects & Bids)│                     │  (Targeted Lead Search) │
└────────────┬────────────┘                     └────────────┬────────────┘
             │                                               │
             └───────────────────────┬───────────────────────┘
                                     │ Raw Post / Project Data
                                     ▼
                        ┌─────────────────────────┐
                        │   All Candidates File   │ ──► [Download 2: All Scraped Data]
                        │ (Immediate Clean Excel) │     (Available Instantly)
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │   Groq AI Pacer Engine  │
                        │  - Header Tracking      │
                        │  - Proactive Wait Buffer│
                        │  - 30 RPM / 8k TPM Sync │
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │    Groq LLaMA / GPT     │
                        │  (Buyer Intent Filter)  │
                        └────────────┬────────────┘
                                     │ Qualified Leads (>= 55% confidence)
                                     ▼
                        ┌─────────────────────────┐
                        │   AI Leads Workbook     │ ──► [Download 1: AI Leads]
                        │   (Live Checkpoints)    │     (Updated Every Batch)
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │ Resend Email Automation │ ──► (Optional Client Inbox)
                        └─────────────────────────┘
```

---

## End-to-End System Workflow

1. **User Authentication**:
   - The user opens the dashboard and logs in using environment-configured credentials (`EMAIL` and `PASSWORD`).
   - The server enforces timing-safe crypto comparison and a strict **20 requests/minute login rate limiter**.
   - Upon successful authentication, a 7-day secure `HttpOnly` cookie (`pulse_session`) is issued.

2. **Triggering a Search Run**:
   - The user clicks **Run** on any role (e.g., *Shopify developer*, *Backend developer*, *SEO specialist*) or configures custom campaigns/budgets on the *Freelancer.com* panel.
   - An in-memory job is created with state `queued` -> `running`.

3. **Data Ingestion (Scraping)**:
   - For **Freelancer.com**: Queries active projects matching campaign keywords within a 3-day sliding window. Projects are filtered by currency (`USD`, `EUR`, `INR`, etc.) and budget limits.
   - For **Twitter / X**: Queries TwitterAPI.io for high-intent purchase expressions (e.g., *"looking to hire"*, *"need a developer"*, *"seeking recommendations"*) while excluding self-promotional spam and employment vacancies.

4. **Instant Candidate Generation (Dual Download Stream 2)**:
   - As soon as the scraper finishes fetching candidates, an **All Candidates workbook** (`all_candidates_<role>.xlsx`) is compiled and stored on disk.
   - The UI immediately lights up the **"Download all data"** button. The user can inspect all raw scraped leads right away without waiting for AI analysis!

5. **AI Evaluation with Intelligent Rate Pacing (Dual Download Stream 1)**:
   - Candidates are processed in batches of 3 through Groq (`openai/gpt-oss-120b`).
   - The **Groq Rate Pacing Engine** tracks Groq's exact rate limits (`30 RPM`, `8k TPM`, `1k RPD`). It proactively spaces requests by 2,500ms and reads live reset headers (`x-ratelimit-reset-tokens: 7.66s`).
   - If limits approach exhaustion, the system automatically pauses, informs the UI with a live countdown, and auto-resumes once the quota resets.
   - Genuine buyer requests with **confidence >= 0.55** are saved into the **AI Leads workbook** (`leads_<role>.xlsx`).

6. **Continuous Atomic Checkpoints**:
   - After *every single batch* of 3 items, the AI workbook is saved to disk atomically (`.tmp.xlsx` -> `.xlsx`).
   - If the user clicks **Stop** or a process stops, all leads evaluated up to that second are 100% safe and downloadable.

7. **Optional Email Notification**:
   - If Resend API keys are configured, the completed spreadsheet is automatically emailed as an attachment to configured recipients.

8. **Automatic Cooldown & Ephemeral Cleanup**:
   - Files remain active for download for 5 minutes (`RUN_TTL_MS = 5 * 60 * 1000`), after which temporary directories and workbooks are safely cleaned up.

---

## Core Subsystems

### 1. Authentication & Security Engine
- **Timing-Safe Validation**: Uses `crypto.timingSafeEqual` with SHA-256 digests to prevent timing-based side-channel attacks on credentials.
- **Session Management**: Session tokens are randomly generated 32-byte hex strings mapped in-memory with a 7-day TTL. Injected via `Set-Cookie: pulse_session=...; HttpOnly; SameSite=Lax; Path=/`.
- **IP-Based Login Rate Limiter**:
  - Implements a sliding-window tracker per client IP.
  - Strictly caps failed/successful login attempts to **20 requests per minute**.
  - Attempt 21 returns `HTTP 429 Too Many Requests` with a standard `Retry-After: <seconds>` header.
  - The login UI displays a live seconds countdown.

### 2. Multi-Source Lead Scrapers
- **Freelancer.com Scraper (`Scripts/freelancer_search.js`)**:
  - Targets Freelancer.com 0.1 active projects API across 8 pre-configured campaigns:
    1. *Frontend & web development*
    2. *Backend & API development*
    3. *Mobile app development*
    4. *Shopify & e-commerce*
    5. *UI/UX & product design*
    6. *SEO & technical SEO*
    7. *Google Ads & PPC*
    8. *Social, content & email marketing*
  - Automatically converts foreign budgets to USD using Freelancer's live exchange rate data.
  - Supports custom budget thresholds (min/max) and currency filtering.
- **Twitter / X Scraper (`Scripts/twitter_search.js`)**:
  - Uses TwitterAPI.io Advanced Search with curated boolean intent queries.
  - Filters out recruitment spam, agency advertisements, resume posts (`"hire me"`, `"open to work"`), and bot mentions.

### 3. Dual Download Pipeline
Every search run produces two distinct Excel outputs:

| Workbook | Filename | Availability | Contents |
| :--- | :--- | :--- | :--- |
| **All Scraped Candidates** | `all_candidates_<role>.xlsx` | **Immediately** after scraping | Clean, clutter-free dataset of every single matched post/project before AI filtering. Omits internal debug timestamps or raw API logs. |
| **AI Qualified Leads** | `leads_<role>.xlsx` | **Live / Checkpointed** after each AI batch | Only verified client leads evaluated with `intent === "buyer_request"` and `confidence >= 0.55`. Includes AI summary, requirements, budget, contact info. |

### 4. Groq AI Classification & Intelligent Rate Pacer

#### The Rate Limiting Challenge
On Groq's free and developer tiers for large models (`openai/gpt-oss-120b`):
- **Request Limit**: `30 RPM` (Requests Per Minute)
- **Token Limit**: `8,000 TPM` (Tokens Per Minute)
- **Day Limits**: `1,000 RPD` / `200,000 TPD`

In earlier versions, 429 errors occurred because:
1. `max_completion_tokens` was set to `4096`. Groq reserves `input_tokens + max_completion_tokens` upfront before generating. Reserving ~6,500+ tokens on an 8,000 TPM tier exhausted the minute's allowance in 1 single call!
2. When 429 occurred, Groq sent `x-ratelimit-reset-tokens: 7.66s`, but the code only waited ~2 seconds and gave up after 3 retries.
3. The catch block executed `break;`, terminating the search and leaving remaining items unanalyzed.

#### The Rate Pacing Solution
1. **Conservative Completion Budget**:
   - `max_completion_tokens` reduced to **1024** for 3-item batches (and **512** for single items). Saves 3,000+ upfront reserved tokens per call.
2. **Input Truncation**:
   - `batchPrompt` truncates project descriptions and tweet text to 1,200 characters, keeping input prompts lean (~800 tokens for 3 items).
3. **Compound Duration Parser (`parseDurationMs`)**:
   - Parses complex header durations: `"7.66s"` -> `7660ms`, `"2m59.56s"` -> `179560ms`, `"500ms"` -> `500ms`.
4. **Live Header Tracking (`groqRateState`)**:
   - Dynamically parses `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, and `retry-after` from every HTTP response.
5. **Proactive Pacing Buffer**:
   - Maintains a 2,500ms minimum interval between calls.
   - If `groqRateState.remainingTokens < 2000`, the engine proactively sleeps until `resetTokensAt + 600ms buffer` before sending the request.
6. **Zero-Drop Auto-Resume**:
   - Retries up to 8 times (`AI_MAX_RETRIES = 8`).
   - Removed `break;` on 429. If rate limits are reached, the UI progress bar displays:
     `"Groq rate limit · waiting 8s for reset (attempt 1/8)"`
   - Resumes seamlessly once the reset timer expires, ensuring 100% of items are classified!

### 5. Email Dispatcher
- Integrated with [Resend](https://resend.com) API.
- If `RESEND_API_KEY`, `LEADS_EMAIL_TO`, and `LEADS_EMAIL_FROM` are set, the completed `.xlsx` file is automatically attached and emailed to stakeholders.
- Automatically validates that attachments stay within Resend's 40 MB threshold.

### 6. Frontend Dashboard & Real-Time Monitoring
- Pure Vanilla HTML5 / Modern CSS / JavaScript (zero build step, lightning-fast load times).
- Modern card-based UI with live polling (`GET /api/scripts` and `GET /api/runs/:id`).
- Real-time progress updates displaying:
  - Current stage name (e.g., *"Searching Freelancer.com"*, *"Analyzing projects"*, *"Waiting for Groq token reset (6s)"*)
  - Processed vs. Total counter (`15 of 84`)
  - Live lead count (`4 leads saved`)
- Dual download buttons:
  - 🟢 **Download AI leads** (or live batch checkpoint)
  - ⚪ **Download all data** (clean raw dataset)
- Stop button for clean user aborts with partial spreadsheet preservation.

---

## Data Schemas & Excel Exports

### 1. AI Qualified Leads (`leads_<role>.xlsx`)

| Column Header | Description |
| :--- | :--- |
| **Project ID / Tweet ID** | Unique source identifier |
| **Posted At / Created At** | ISO timestamp of publication |
| **Campaigns / Username** | Matched campaign tags or author handle |
| **Title** | Project title (Freelancer) |
| **Description / Tweet Text** | Text content of client post |
| **Project Type** | Fixed price or hourly project |
| **Budget** | Original currency budget range |
| **Bids / Average Bid** | Bid statistics and calculated USD averages |
| **Intent** | Classified intent (`buyer_request`, `hiring`, etc.) |
| **Potential Lead** | Boolean (`true` / `false`) |
| **Project Summary** | AI concise summary of what client needs |
| **Requirements** | Extracted tech stack & skills |
| **Confidence** | AI model confidence score (0.0 to 1.0) |
| **Project URL / Tweet URL** | Direct clickable link to the source post |

### 2. All Candidates Clean Dataset (`all_candidates_<role>.xlsx`)

| Column Header | Description |
| :--- | :--- |
| **Project ID / Tweet ID** | Unique source identifier |
| **Posted At / Created At** | ISO timestamp of publication |
| **Campaigns / Search Role** | Matched campaign or search track |
| **Title** | Project title (Freelancer) |
| **Description / Tweet Text** | Clean text content |
| **Project Type** | Hourly / Fixed |
| **Budget** | Budget range in original currency |
| **Bids** | Number of proposals submitted |
| **Average Bid (USD)** | Normalized USD average |
| **Language** | Post language |
| **Project URL / Tweet URL** | Direct link to project |

---

## API Endpoint Reference

### Authentication Endpoints

#### `POST /api/auth/login`
- **Body**: `{ "email": "admin@example.com", "password": "password" }`
- **Response**: `200 OK` + `Set-Cookie: pulse_session=...`
- **Rate Limit**: Max 20 requests per minute per IP. Returns `429` on exceed.

#### `POST /api/auth/logout`
- **Response**: `200 OK` (Clears session cookie)

#### `GET /api/auth/me`
- **Response**: `{ "authenticated": true, "email": "admin@example.com" }`

---

### Lead Generation Endpoints

#### `GET /api/scripts`
- **Description**: Returns all available roles, active running jobs, and cooldown timestamps.
- **Auth**: Requires valid session cookie.

#### `POST /api/runs`
- **Description**: Starts a new scraping & classification run.
- **Auth**: Requires valid session cookie.
- **Body**:
  ```json
  {
    "script": "freelancer",
    "options": {
      "campaigns": ["frontend", "backend", "shopify"],
      "currency": "USD",
      "minBudget": 100,
      "maxBudget": 5000
    }
  }
  ```
- **Response**: `202 Accepted` with initial job payload.

#### `GET /api/runs/:id`
- **Description**: Polls live job status, progress percentage, leads found, and download availability.

#### `POST /api/runs/:id/stop`
- **Description**: Requests graceful termination. The current batch finishes and partial results are saved.

#### `GET /api/runs/:id/download`
- **Description**: Streams the AI Qualified Leads Excel workbook (`leads_<role>.xlsx`).

#### `GET /api/runs/:id/download/raw`
- **Description**: Streams the All Candidates Excel workbook (`all_candidates_<role>.xlsx`).

#### `GET /health`
- **Description**: Health check endpoint for uptime monitors (Render, UptimeRobot). Returns `{ "ok": true }`.

---

## Environment Variables

Configure these in your `.env` file locally or in the Render Dashboard:

```env
# Server Port & Binding (Defaults to 3000 locally, dynamically assigned on Render)
PORT=3000

# Authentication Credentials
EMAIL=admin@example.com
PASSWORD=your_secure_password_here

# Groq AI Service
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_MIN_INTERVAL_MS=2500

# Twitter / X API Service (Optional if only using Freelancer.com)
TWITTER_API_KEY=your_twitterapi_io_key_here

# Resend Email Delivery (Optional)
RESEND_API_KEY=re_your_resend_api_key_here
LEADS_EMAIL_TO=leads@yourdomain.com,team@yourdomain.com
LEADS_EMAIL_FROM=notifications@yourdomain.com
```

---

## Local Setup & Testing

### 1. Prerequisites
- Node.js version **>= 18.0.0** (native `fetch` support required).
- npm (comes with Node.js).

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/arjun-wft/projectpulse.git
cd projectpulse

# Install dependencies
npm install

# Setup environment variables
cp .env.exmaple .env
# Edit .env with your credentials and API keys
```

### 3. Run Development Server
```bash
npm start
# Server starts on http://localhost:3000
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Automated Tests
The repository includes automated test suites covering:
- **Authentication & Rate Limiter**: 11 automated test cases.
- **Dual Download Pipeline**: 6 automated test cases verifying schema integrity and download routes.
- **Groq Rate Pacing**: Automated 429 mock recovery and compound duration parsing.

To run syntax checks:
```bash
node --check server.js
```

---

## Production Deployment (Render.com)

Project Pulse is optimized for 1-click deployment on **Render.com** as a **Web Service**:

1. **Connect Repository**:
   - In the Render Dashboard, click **New +** -> **Web Service**.
   - Select your GitHub repository: `arjun-wft/projectpulse`.

2. **Configure Service Settings**:
   - **Environment**: `Node`
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`

3. **Configure Environment Variables**:
   Under the **Environment** tab on Render, add:
   - `EMAIL`
   - `PASSWORD`
   - `GROQ_API_KEY`
   - `TWITTER_API_KEY` (if X search is desired)
   - `GROQ_MODEL` (default: `openai/gpt-oss-120b`)
   - `RESEND_API_KEY`, `LEADS_EMAIL_TO`, `LEADS_EMAIL_FROM` (if email alerts are desired)

4. **Deploy**:
   - Click **Deploy Web Service**.
   - Once deployed, Render will provide a live HTTPS URL (e.g., `https://projectpulse.onrender.com`).
   - Log in with your configured `EMAIL` and `PASSWORD` to start generating leads!
