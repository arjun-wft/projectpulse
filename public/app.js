const scriptList = document.querySelector('#scripts');
const recentSection = document.querySelector('#recent-section');
const recentRuns = document.querySelector('#recent-runs');
const toast = document.querySelector('#toast');
const freelancerCampaignList = document.querySelector('#freelancer-campaigns');
const freelancerButton = document.querySelector('#freelancer-run');
const freelancerStatus = document.querySelector('#freelancer-status');
const knownKey = 'pulse-known-run-ids';
const notifiedKey = 'pulse-notified-run-ids';
let scripts = [];
let runs = [];
let toastTimer;
let refreshing = false;
let offline = false;
let freelancerCampaigns = [];
let freelancerCampaignsLoaded = false;
let pollTimer = null;

function readIds(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveIds(key, ids) {
  try { localStorage.setItem(key, JSON.stringify([...ids].slice(-100))); } catch {}
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
}
function formatRemaining(timestamp) {
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function runStatus(run) {
  if (!run) return { text: '', className: '' };
  if (run.status === 'queued') return { text: 'Starting…', className: '' };
  if (run.status === 'running') {
    const detail = run.total ? ` · ${run.processed} of ${run.total}` : '';
    const leads = run.leadsFound ? ` · ${run.leadsFound} leads saved` : '';
    return { text: `${run.stage}${detail}${leads}`, className: '' };
  }
  if (run.status === 'completed' || run.status === 'stopped') {
    const leads = run.result?.leadsFound ?? 0;
    const notes = [];
    const itemName = run.script === 'freelancer' ? 'projects' : 'tweets';
    if (run.result?.analysisErrors) notes.push(`${run.result.analysisErrors} ${itemName} skipped`);
    if (run.result?.searchErrors) notes.push(`${run.result.searchErrors} searches partial`);
    if (run.result?.rateLimited) notes.push('Groq rate limit after retries');
    if (run.result?.partialReason && run.status !== 'stopped' && !run.result?.rateLimited) notes.push('some processing was interrupted');
    if (run.result?.email?.error) notes.push('email could not be sent');
    const searchDetail = run.result?.searchErrorDetails?.[0];
    if (searchDetail) notes.push(searchDetail.slice(0, 120));
    const warning = notes.length ? ` · ${notes.join(', ')}` : '';
    const checked = run.script === 'freelancer' && Number.isFinite(run.result?.projectsAnalyzed)
      ? ` · ${run.result.projectsAnalyzed} projects checked` : '';
    const stopped = run.status === 'stopped' ? 'Stopped · partial Excel ready' : run.result?.rateLimited ? 'Rate limit · partial Excel ready' : run.result?.partialReason ? 'Partial Excel ready' : 'Excel ready';
    const email = run.result?.email?.sent ? ' · emailed' : '';
    return { text: `${stopped} · ${leads} ${leads === 1 ? 'lead' : 'leads'}${checked}${warning}${email} · link expires in ${formatRemaining(run.expiresAt)}`, className: 'success' };
  }
  return { text: run.error || 'This run could not finish. Try again.', className: 'error' };
}
function latestRun(scriptId) { return runs.find(run => run.script === scriptId); }
function makeDownloadLink(run, compact = false) {
  const link = document.createElement('a');
  link.className = 'download-button'; link.href = run.downloadUrl;
  link.textContent = compact ? 'Download' : 'Download Excel';
  link.setAttribute('download', run.fileName || 'leads.xlsx');
  link.addEventListener('click', event => { event.preventDefault(); downloadRun(run); });
  return link;
}
async function downloadRun(run) {
  try {
    const response = await fetch(run.downloadUrl);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'This Excel link expired. Run the search again.');
    }
    const file = await response.blob();
    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = objectUrl; link.download = run.fileName || 'leads.xlsx';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    showToast(error.message === 'Failed to fetch' ? 'Could not reach the server. Please try again.' : error.message);
  }
}
function renderScripts() {
  scriptList.replaceChildren();
  const anyRunning = scripts.some(script => script.running);
  for (const script of scripts.filter(item => item.id !== 'freelancer')) {
    const run = latestRun(script.id) || script.activeRun;
    const card = document.createElement('article'); card.className = 'script-card';
    const info = document.createElement('div'); info.className = 'script-info';
    const title = document.createElement('h3'); title.className = 'script-title'; title.textContent = script.title;
    const description = document.createElement('p'); description.className = 'script-description'; description.textContent = script.description;
    info.append(title, description);
    const status = document.createElement('p'); status.className = 'run-status';
    if (script.running && script.activeRun) {
      const current = runStatus(script.activeRun); status.textContent = current.text;
    } else if (run) {
      const current = runStatus(run); status.textContent = current.text; status.classList.add(current.className);
    } else if (script.retryAt && script.retryAt > Date.now()) {
      status.textContent = `Available again in ${formatRemaining(script.retryAt)}`;
    }
    if (status.textContent) info.append(status);
    const button = document.createElement('button');
    button.className = 'run-button'; button.type = 'button';
    button.textContent = script.running ? (script.activeRun?.stopRequested ? 'Stopping…' : 'Stop') : run?.status === 'failed' ? 'Try again' : anyRunning ? 'Wait' : 'Run';
    button.disabled = (script.running && Boolean(script.activeRun?.stopRequested)) || (!script.running && (anyRunning || Boolean(script.retryAt && script.retryAt > Date.now())));
    button.classList.toggle('stop-button', script.running);
    button.addEventListener('click', () => script.running ? stopRun(script.activeRun, button) : startRun(script.id, button));
    card.append(info);
    if (script.running) card.append(button);
    if (run?.downloadUrl) card.append(makeDownloadLink(run));
    if (!script.running && !run?.downloadUrl) card.append(button);
    scriptList.append(card);
  }
}
function renderFreelancer() {
  const script = scripts.find(item => item.id === 'freelancer');
  const run = latestRun('freelancer') || script?.activeRun;
  const anyRunning = scripts.some(item => item.running);
  freelancerStatus.textContent = '';
  freelancerStatus.className = 'run-status';
  if (script?.running && script.activeRun) {
    freelancerStatus.textContent = runStatus(script.activeRun).text;
  } else if (run) {
    const state = runStatus(run);
    freelancerStatus.textContent = state.text;
    freelancerStatus.classList.add(state.className);
  } else if (script?.retryAt && script.retryAt > Date.now()) {
    freelancerStatus.textContent = `Available again in ${formatRemaining(script.retryAt)}`;
  }
  const hasSelection = freelancerCampaignList.querySelector('input:checked');
  const coolingDown = Boolean(script?.retryAt && script.retryAt > Date.now());
  const stopping = Boolean(script?.activeRun?.stopRequested);
  freelancerButton.disabled = stopping || (!script?.running && (!freelancerCampaignsLoaded || !hasSelection || anyRunning || coolingDown));
  freelancerButton.textContent = script?.running ? stopping ? 'Stopping…' : 'Stop campaign' : coolingDown ? 'Cooling down' : run?.status === 'failed' ? 'Try again' : 'Run campaigns';
  freelancerButton.classList.toggle('stop-button', Boolean(script?.running));
}
async function loadFreelancerCampaigns() {
  try {
    const response = await fetch('/api/freelancer/campaigns');
    if (!response.ok) throw new Error('Could not load Freelancer.com campaigns.');
    freelancerCampaigns = await response.json();
    freelancerCampaignList.replaceChildren();
    for (const campaign of freelancerCampaigns) {
      const label = document.createElement('label'); label.className = 'campaign-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = campaign.id;
      input.addEventListener('change', renderFreelancer);
      const copy = document.createElement('span');
      const name = document.createElement('span'); name.className = 'campaign-name'; name.textContent = campaign.title;
      const keywords = document.createElement('span'); keywords.className = 'campaign-keywords'; keywords.textContent = campaign.keywords.join(' · ');
      copy.append(name, keywords);
      label.append(input, copy); freelancerCampaignList.append(label);
    }
    freelancerCampaignsLoaded = true;
    renderFreelancer();
  } catch {
    freelancerCampaignList.textContent = 'Could not load campaigns. Refresh the page to try again.';
  }
}
function renderRecent() {
  recentRuns.replaceChildren();
  const visible = runs.slice(0, 8);
  recentSection.hidden = visible.length === 0;
  for (const run of visible) {
    const card = document.createElement('article'); card.className = 'recent-card';
    const info = document.createElement('div'); info.className = 'recent-info';
    const title = document.createElement('h3'); title.className = 'recent-title'; title.textContent = run.title;
    const detail = document.createElement('p'); detail.className = 'recent-detail';
    detail.textContent = runStatus(run).text;
    info.append(title, detail); card.append(info);
    if (run.downloadUrl) card.append(makeDownloadLink(run, true));
    recentRuns.append(card);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [scriptResponse, runResponse] = await Promise.all([fetch('/api/scripts'), fetch('/api/runs')]);
    if (!scriptResponse.ok || !runResponse.ok) throw new Error('Could not refresh run status.');
    scripts = await scriptResponse.json();
    const nextRuns = await runResponse.json();
    const known = readIds(knownKey); const notified = readIds(notifiedKey);
    for (const run of nextRuns) {
      if (known.has(run.id) && ['completed', 'stopped'].includes(run.status) && !notified.has(run.id)) {
        showToast(`${run.status === 'stopped' ? 'Partial Excel is ready' : 'Excel is ready'} for ${run.title}.`);
        notified.add(run.id);
      }
    }
    saveIds(notifiedKey, notified);
    runs = nextRuns;
    renderScripts(); renderFreelancer(); renderRecent();
    if (offline) showToast('Connection restored.');
    offline = false;
  } catch {
    if (!offline) showToast('Can’t reach the server. Check that it is running, then refresh.');
    offline = true;
  } finally { refreshing = false; }
}
function schedulePoll() {
  clearTimeout(pollTimer);
  const activeRun = scripts.some(script => script.running) || runs.some(run => run.status === 'queued' || run.status === 'running');
  const delay = document.hidden
    ? (activeRun ? 10000 : 60000)
    : (activeRun ? 2000 : 15000);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}
async function startRun(scriptId, button, options = {}) {
  button.disabled = true; button.textContent = 'Starting…';
  try {
    const response = await fetch('/api/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: scriptId, ...options }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not start this search. Try again.');
    const known = readIds(knownKey); known.add(data.id); saveIds(knownKey, known);
    showToast(`${data.title} search started.`);
    await refresh();
    schedulePoll();
  } catch (error) {
    showToast(error.message === 'Failed to fetch' ? 'Can’t reach the server. Check that it is running.' : error.message);
    button.disabled = false; button.textContent = 'Try again';
  }
}
async function stopRun(run, button) {
  if (!run?.id) return;
  button.disabled = true; button.textContent = 'Stopping…';
  try {
    const response = await fetch(`/api/runs/${run.id}/stop`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not stop this run.');
    showToast('Stop requested. The current request will finish, then the saved Excel will be available.');
    await refresh();
  } catch (error) {
    showToast(error.message === 'Failed to fetch' ? 'Can’t reach the server. Check the connection.' : error.message);
    button.disabled = false;
  }
}
freelancerButton.addEventListener('click', () => {
  const active = scripts.find(item => item.id === 'freelancer')?.activeRun;
  if (active) { stopRun(active, freelancerButton); return; }
  const campaigns = [...freelancerCampaignList.querySelectorAll('input:checked')].map(input => input.value);
  const rawMin = document.querySelector('#freelancer-min').value.trim();
  const rawMax = document.querySelector('#freelancer-max').value.trim();
  const minBudget = rawMin === '' ? null : Number(rawMin);
  const maxBudget = rawMax === '' ? null : Number(rawMax);
  if (minBudget != null && (!Number.isFinite(minBudget) || minBudget < 0)) return showToast('Minimum budget must be a non-negative number.');
  if (maxBudget != null && (!Number.isFinite(maxBudget) || maxBudget < 0)) return showToast('Maximum budget must be a non-negative number.');
  if (minBudget != null && maxBudget != null && maxBudget < minBudget) return showToast('Maximum budget must be at least the minimum.');
  startRun('freelancer', freelancerButton, {
    campaigns,
    currency: document.querySelector('#freelancer-currency').value,
    minBudget,
    maxBudget,
  });
});
loadFreelancerCampaigns();
refresh().finally(schedulePoll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().finally(schedulePoll);
  else schedulePoll();
});
