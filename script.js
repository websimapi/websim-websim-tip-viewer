import DOMPurify from "dompurify";
import { marked } from "marked";

/* ...existing code... */
const form = document.getElementById('lookupForm');
const input = document.getElementById('projectInput');
const status = document.getElementById('status');
const tipsList = document.getElementById('tipsList');
const pager = document.getElementById('pager');
const loadMoreBtn = document.getElementById('loadMore');
const useCurrentBtn = document.getElementById('useCurrent');

let projectId = null;
let endCursor = null;
let hasNext = false;

function setStatus(txt) {
  status.textContent = txt;
}

function extractProjectId(value) {
  if (!value) return null;
  // If it's a URL containing /projects/{id}
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('projects');
    if (idx >= 0 && parts[idx+1]) return parts[idx+1];
    // fallback: last segment
    return parts.pop();
  } catch (e) {
    // not a URL, treat as id
    return value.trim();
  }
}

async function fetchProjectBySlug(username, slug, version = null) {
    const endpoint = version
        ? `/api/v1/users/${username}/slugs/${slug}/revisions/${version}`
        : `/api/v1/users/${username}/slugs/${slug}`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`Failed to fetch slug: ${res.status}`);
    return await res.json();
}

function parseWebSimUrl(value) {
    try {
        const url = new URL(value);
        const pathname = url.pathname;
        // /p/{id} or /p/{id}/{ver}
        const projectMatch = pathname.match(/^\/p\/([a-zA-Z0-9_-]{6,})(?:\/(\d+))?$/);
        if (projectMatch) return { type: 'project', id: projectMatch[1], version: projectMatch[2] ? parseInt(projectMatch[2]) : null };
        // /@username/slug or /@username/slug/version
        const slugMatch = pathname.match(/^\/@([a-zA-Z0-9_]{1,32})\/([a-zA-Z0-9-]{1,100})(?:\/(\d+))?$/);
        if (slugMatch) return { type: 'slug', username: slugMatch[1], slug: slugMatch[2], version: slugMatch[3] ? parseInt(slugMatch[3]) : null };
        // /@username (profile)
        const profileMatch = pathname.match(/^\/@([a-zA-Z0-9_]{1,32})$/);
        if (profileMatch) return { type: 'profile', username: profileMatch[1] };
    } catch (e) {
        // not a full URL
    }
    return null;
}

async function resolveProjectId(inputVal) {
    // Try to interpret as URL first
    const parsed = parseWebSimUrl(inputVal);
    if (parsed) {
        if (parsed.type === 'project') return parsed.id;
        if (parsed.type === 'slug') {
            const data = await fetchProjectBySlug(parsed.username, parsed.slug, parsed.version);
            // API returns { project, project_revision } — project.id is the id we need
            return data.project?.id;
        }
        // profile only -> no specific project
        throw new Error('Profile URL provided; please supply a project slug or project URL.');
    }
    // fallback: treat as plain id
    return inputVal.trim();
}

function renderTip(item) {
  const c = item.comment;
  const author = c.author || {};
  const credits = c.card_data?.credits_spent ?? 0;
  const li = document.createElement('li');
  li.className = 'tip';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (author.avatar_url) {
    const img = document.createElement('img');
    img.src = author.avatar_url;
    img.alt = author.username || 'avatar';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    avatar.innerHTML = '';
    avatar.appendChild(img);
  } else {
    avatar.textContent = (author.username || 'U').slice(0,2).toUpperCase();
  }

  const meta = document.createElement('div');
  meta.className = 'meta';

  const row = document.createElement('div');
  row.className = 'row';

  const name = document.createElement('div');
  name.innerHTML = `<div class="name">${author.display_name ?? author.username ?? 'Unknown'}</div>
                    <div class="muted small">${new Date(c.created_at).toLocaleString()}</div>`;

  const amount = document.createElement('div');
  amount.className = 'amount';
  amount.textContent = `${credits} credits`;

  row.appendChild(name);
  row.appendChild(amount);

  const body = document.createElement('div');
  body.className = 'comment-body';
  const raw = c.raw_content || '';
  const html = DOMPurify.sanitize(marked.parse(raw));
  body.innerHTML = html;

  meta.appendChild(row);
  meta.appendChild(body);

  li.appendChild(avatar);
  li.appendChild(meta);
  return li;
}

async function fetchTips(after = null) {
  setStatus('Loading tip comments...');
  tipsList.hidden = true;
  pager.hidden = true;
  try {
    const params = new URLSearchParams({ only_tips: 'true', first: 12 });
    if (after) params.append('after', after);
    const res = await fetch(`/api/v1/projects/${projectId}/comments?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const block = data.comments;
    if (!block || !block.data || block.data.length === 0) {
      if (!after) setStatus('No tip comments found.');
      else setStatus('No more tip comments.');
      return { items: [], meta: block?.meta };
    }
    setStatus(`Loaded ${block.data.length} tip(s).`);
    return { items: block.data, meta: block.meta };
  } catch (err) {
    console.error(err);
    setStatus('Error loading comments. See console.');
    return { items: [], meta: null };
  }
}

async function runLookup(e) {
  if (e) e.preventDefault();
  try {
    const raw = input.value;
    if (!raw) { setStatus('Enter a project URL or id.'); return; }
    setStatus('Resolving project identifier...');
    projectId = await resolveProjectId(raw);
  } catch (err) {
    setStatus(err.message || 'Unable to resolve project id.');
    return;
  }
  if (!projectId) { setStatus('Could not determine project id.'); return; }
  tipsList.innerHTML = '';
  endCursor = null;
  hasNext = false;

  setStatus('Looking up project...');
  // quick check: try to fetch project to confirm id
  try {
    const pRes = await fetch(`/api/v1/projects/${projectId}`);
    if (!pRes.ok) {
      setStatus('Project not found or inaccessible.');
      return;
    }
  } catch (err) {
    console.warn('project fetch failed', err);
    // continue; maybe comments endpoint will work
  }

  const { items, meta } = await fetchTips();
  if (items.length === 0) return;
  tipsList.hidden = false;
  for (const it of items) {
    const el = renderTip(it);
    tipsList.appendChild(el);
  }
  endCursor = meta?.end_cursor ?? null;
  hasNext = !!meta?.has_next_page;
  pager.hidden = !hasNext;
  if (hasNext) setStatus(`Showing ${items.length} tips — more available.`);
}

async function loadMore() {
  if (!hasNext || !endCursor) return;
  loadMoreBtn.disabled = true;
  const { items, meta } = await fetchTips(endCursor);
  for (const it of items) {
    const el = renderTip(it);
    tipsList.appendChild(el);
  }
  endCursor = meta?.end_cursor ?? null;
  hasNext = !!meta?.has_next_page;
  pager.hidden = !hasNext;
  loadMoreBtn.disabled = false;
}

form.addEventListener('submit', runLookup);
loadMoreBtn.addEventListener('click', loadMore);

useCurrentBtn.addEventListener('click', async () => {
  setStatus('Fetching current project...');
  try {
    const project = await window.websim.getCurrentProject();
    input.value = project.id;
    await runLookup();
  } catch (err) {
    console.error(err);
    setStatus('Unable to get current project. Make sure this is run inside Websim.');
  }
});

/* ...existing code... */