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
    return { text: `${run.stage}${detail}`, className: '' };
  }
  if (run.status === 'completed') {
    const leads = run.result?.leadsFound ?? 0;
    const notes = [];
    const itemName = run.script === 'freelancer' ? 'projects' : 'tweets';
    if (run.result?.analysisErrors) notes.push(`${run.result.analysisErrors} ${itemName} skipped`);
    if (run.result?.searchErrors) notes.push(`${run.result.searchErrors} searches partial`);
    const searchDetail = run.result?.searchErrorDetails?.[0];
    if (searchDetail) notes.push(searchDetail.slice(0, 120));
    const warning = notes.length ? ` · ${notes.join(', ')}` : '';
    const checked = run.script === 'freelancer' && Number.isFinite(run.result?.projectsAnalyzed)
      ? ` · ${run.result.projectsAnalyzed} projects checked` : '';
    return { text: `Excel ready · ${leads} ${leads === 1 ? 'lead' : 'leads'}${checked}${warning} · link expires in ${formatRemaining(run.expiresAt)}`, className: 'success' };
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
    button.textContent = script.running ? 'Running…' : run?.status === 'failed' ? 'Try again' : anyRunning ? 'Wait' : 'Run';
    button.disabled = script.running || anyRunning || Boolean(script.retryAt && script.retryAt > Date.now());
    button.addEventListener('click', () => startRun(script.id, button));
    if (run?.status === 'completed' && run.downloadUrl) card.append(info, makeDownloadLink(run));
    else card.append(info, button);
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
  freelancerButton.disabled = !freelancerCampaignsLoaded || !hasSelection || anyRunning || coolingDown;
  freelancerButton.textContent = script?.running ? 'Running…' : coolingDown ? 'Cooling down' : run?.status === 'failed' ? 'Try again' : 'Run campaigns';
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
    if (run.status === 'completed' && run.downloadUrl) card.append(makeDownloadLink(run, true));
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
      if (known.has(run.id) && run.status === 'completed' && !notified.has(run.id)) {
        showToast(`Excel is ready for ${run.title}. Download it before the link expires.`);
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
freelancerButton.addEventListener('click', () => {
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
