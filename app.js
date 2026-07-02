// ─── HTML ESCAPE UTILITY ───────────────────────────────────────────────────
// Use esc() whenever inserting user-controlled text into innerHTML.
// This prevents stored XSS: a script title or logline containing <script> or
// onerror= handlers cannot execute because the characters are entity-encoded.
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── SCENEONE CONFIG — fill in tonight before pushing ───
const SUPABASE_URL      = 'https://zzsjgaijrngxkaqakplm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_yuptAX-fJGnyTuDgReScEg_bqg7qPEx';
const EDGE_FN_URL       = SUPABASE_URL + '/functions/v1/grade-script';
const NOTIFY_FN_URL     = SUPABASE_URL + '/functions/v1/notify';
const supabaseClient = (() => {
  try {
    if (!window.supabase) throw new Error('supabase-js did not load');
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch(e) {
    console.error('SceneOne: Supabase client init failed —', e.message);
    return null;
  }
})();

// ─── KEEP-WARM PING — prevent edge function cold starts (writers only) ───
// Started after auth confirms user is logged in, not for every visitor.
let _keepWarmInterval = null;
function _startKeepWarm() {
  if (_keepWarmInterval) return;
  const ping = () => fetch(EDGE_FN_URL, { method: 'POST', body: JSON.stringify({keepWarm:true}), headers:{'Content-Type':'application/json'} }).catch(() => {});
  ping();
  _keepWarmInterval = setInterval(ping, 4 * 60 * 1000);
}

// ─── SESSION PERSISTENCE — restore auth on every page load ───
(async () => {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.user) {
      _currentUser = session.user;
      userName = session.user.user_metadata?.full_name?.split(' ')[0]
                 || session.user.email.split('@')[0];
      // Restore last screen so browser refresh doesn't kick users back to upload
      let lastScreen = 'upload';
      try { lastScreen = sessionStorage.getItem('so_last_screen') || 'upload'; } catch(_){}
      if (!_PERSISTENT_SCREENS.has(lastScreen)) lastScreen = 'upload';
      goTo(lastScreen);
      if (lastScreen === 'upload') loadScriptHistory();
      _startKeepWarm();
    }
  } catch (e) {
    console.warn('SceneOne: session restore failed', e);
  }
})();

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    _currentUser = session?.user || null;
  });
}

const _PDFJS_URL        = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const _PDFJS_SRI        = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
const _PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function _loadPdfJs() {
  if (typeof pdfjsLib !== 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = _PDFJS_URL;
    s.integrity = _PDFJS_SRI;
    s.crossOrigin = 'anonymous';
    s.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = _PDFJS_WORKER_URL;
      resolve();
    };
    s.onerror = () => reject(new Error('Failed to load pdf.js'));
    document.head.appendChild(s);
  });
}

// ─── PDF / FILE TEXT EXTRACTION ───
async function extractScriptText(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    await _loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  }

  // FDX, Fountain, TXT — all plain/XML text
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

// ─── API COORDINATION ───
let _loaderDone = false;
let _apiDone    = false;
let _reportData = null;

function _onLoaderAnimDone() {
  _loaderDone = true;
  if (_apiDone) {
    _finalizeReport();
  } else {
    // Keep bar at 99% with a waiting message
    const bar = document.getElementById('proc-bar');
    const ph  = document.getElementById('proc-phrase');
    if (bar) bar.style.width = '99%';
    if (ph)  ph.textContent  = 'Running deep structural analysis...';
  }
}

function _onApiDone(data) {
  _apiDone    = true;
  _reportData = data;
  if (_loaderDone) _finalizeReport();
}

async function _restoreListingState() {
  const id = await _ensureSubId();
  if (!id) return;
  const { data } = await supabaseClient.from('submissions').select('public_listing').eq('id', id).single();
  if (data?.public_listing) {
    const toggle = document.getElementById('listing-toggle-input');
    if (toggle) toggle.checked = true;
    const label = document.getElementById('listing-status-label');
    if (label) label.textContent = 'Live';
    const privateNotice = document.getElementById('listing-private');
    if (privateNotice) privateNotice.style.display = 'none';
    const liveSection = document.getElementById('listing-live');
    if (liveSection) liveSection.style.display = 'block';
    loadListingStats(id);
    loadRequestCards(id);
  }
}

function _finalizeReport() {
  if (_reportData) populateReport(_reportData);

  if (window._isSampleRun) {
    const sv = document.getElementById('stat-views'); if (sv) sv.textContent = '7';
    const sr = document.getElementById('stat-requests'); if (sr) sr.textContent = '2';
    const pl = document.getElementById('pending-requests-label'); if (pl) pl.textContent = '2 pending requests.';
  }

  setTimeout(() => {
    goTo('report');
    _restoreListingState();
    if (isFirstTime) {
      isFirstTime = false;
      setTimeout(() => {
        if (_reportData) {
          const catNames = { structure:'Structure', conflict:'Conflict', dialogue:'Dialogue', pacing:'Pacing', visual:'Visual' };
          const sc = _reportData.scores || {};
          const entries = Object.entries(sc).filter(([,v])=>typeof v==='number');
          if (entries.length) {
            entries.sort(([,a],[,b])=>b-a);
            const [bestKey, bestVal] = entries[0];
            const [lowKey, lowVal]   = entries[entries.length-1];
            const cel1 = document.getElementById('cel-overall');
            const celBv = document.getElementById('cel-best-val');
            const celBl = document.getElementById('cel-best-lbl');
            const celLv = document.getElementById('cel-low-val');
            const celLl = document.getElementById('cel-low-lbl');
            if (cel1)  cel1.textContent  = _reportData.overall_score ?? '—';
            if (celBv) celBv.textContent = bestVal;
            if (celBl) celBl.textContent = 'Best: ' + (catNames[bestKey] || bestKey);
            if (celLv) celLv.textContent = lowVal;
            if (celLl) celLl.textContent = 'Fix: ' + (catNames[lowKey] || lowKey);
          }
        }
        const cel = document.getElementById('ob-celebrate');
        cel.style.display = 'flex';
        cel.classList.add('show');
      }, 600);
    }
  }, 800);
}

// ─── POPULATE REPORT FROM REAL DATA ───
function populateReport(d) {
  if (!d) return;

  // Store real scores for burn animations
  if (d.scores) window._lastScores = d.scores;

  // Page count (calculated from script text length before API call)
  const pg = window._scriptPageCount || '—';
  const pgEl = document.getElementById('stat-page-count');
  const pgSub = document.getElementById('stat-page-sub');
  const pgExec = document.getElementById('exec-page-count');
  const pgHeat = document.getElementById('heatmap-page-meta');
  if (pgEl) pgEl.textContent = pg + ' pgs';
  if (pgSub) pgSub.textContent = pg + ' pages · ' + (d.character_count ? d.character_count + ' characters' : 'Feature');
  if (pgExec) pgExec.textContent = 'Feature · ' + pg + ' pages';
  if (pgHeat) pgHeat.textContent = 'Page by page · ' + pg + ' pages';

  // Exec Mode — Save the Cat beat read, from the real save_the_cat analysis
  const stcEl = document.getElementById('exec-stc-beat');
  if (stcEl && d.save_the_cat) {
    const beatName = s => (typeof s === 'string') ? s.split(/\s[—–-]\s/)[0].trim().slice(0, 26) : '';
    const strong = beatName(d.save_the_cat.strongest_beat);
    const weak = beatName(d.save_the_cat.weakest_beat);
    if (strong || weak) {
      stcEl.textContent = (strong ? 'Strong: ' + strong : '') + (strong && weak ? ' · ' : '') + (weak ? 'Soft: ' + weak : '');
    } else if (d.save_the_cat.summary) {
      stcEl.textContent = d.save_the_cat.summary.slice(0, 60);
    }
  }

  // ── Exec Mode — populate the development assessment from real data ──
  const _dimName = { structure:'Structure', conflict:'Conflict', dialogue:'Dialogue', pacing:'Pacing', visual:'Visual' };
  const _setExec = (id, v) => { const e = document.getElementById(id); if (e && v != null && v !== '') e.textContent = v; };

  if (Array.isArray(d.story_dna) && d.story_dna.length)
    _setExec('exec-comp', d.story_dna.map(x => x.film).filter(Boolean).join(' · '));
  if (d.overall_score != null) _setExec('exec-craft', d.overall_score + ' / 100');
  _setExec('exec-page-count', (_scriptType === 'short' ? 'Short Film' : 'Feature') + ' · ' + (window._scriptPageCount || '—') + ' pages');

  if (d.scores) {
    const _e = Object.entries(d.scores).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]);
    if (_e.length) {
      const [hiK, hiV] = _e[0], [loK, loV] = _e[_e.length - 1];
      _setExec('exec-strength', (_dimName[hiK] || hiK) + ' · ' + hiV);
      const loRef = d.categories?.[loK]?.page_ref;
      _setExec('exec-flag', (_dimName[loK] || loK) + ' · ' + (loRef || loV));
    }
  }

  if (d.exec) {
    _setExec('exec-genre', d.exec.genre);
    _setExec('exec-budget', d.exec.budget_tier);
    if (d.exec.named_characters != null) _setExec('exec-named', d.exec.named_characters + ' named');
  }

  // Recommendation verdict — from the exec analysis, or derived from craft score
  let _verdict = d.exec?.recommendation;
  if (!_verdict && d.overall_score != null) _verdict = d.overall_score >= 80 ? 'Recommend' : (d.overall_score >= 65 ? 'Consider' : 'Pass');
  if (_verdict) {
    const _map = {
      Recommend: { color: 'var(--green)', icon: '✓', title: 'Recommend — Strong Craft' },
      Consider:  { color: 'var(--amber)', icon: '⚠', title: 'Consider — Pending Revision' },
      Pass:      { color: 'var(--sub)',   icon: '✕', title: 'Pass — Not Ready for Coverage' }
    };
    const _m = _map[_verdict] || _map.Consider;
    const _ic = document.getElementById('exec-rec-icon');
    const _ti = document.getElementById('exec-rec-title');
    const _bo = document.getElementById('exec-rec-body');
    if (_ic) { _ic.textContent = _m.icon; _ic.style.color = _m.color; }
    if (_ti) { _ti.textContent = _m.title; _ti.style.color = _m.color; }
    if (_bo && d.exec?.recommendation_note) _bo.textContent = d.exec.recommendation_note;
  }

  // Pacing flag — update from real category data
  const pacingCat = d.categories?.pacing;
  if (pacingCat) {
    const flagSub  = document.getElementById('pacing-flag-sub');
    const flagBadge = document.getElementById('pacing-flag-badge');
    const hmFlag   = document.getElementById('heatmap-flag');
    if (flagSub  && pacingCat.page_ref) flagSub.textContent  = 'Score ' + (d.scores?.pacing ?? '—') + ' · ' + pacingCat.page_ref;
    if (flagBadge && pacingCat.flag)    flagBadge.textContent = '⚠ ' + pacingCat.flag.slice(0, 40);
    if (hmFlag   && pacingCat.page_ref) hmFlag.textContent   = '⚠ Flagged: ' + pacingCat.page_ref + ' — momentum stalls here';
  }

  // Overall score
  document.querySelectorAll('.sidebar-score-big').forEach(el => el.textContent = d.overall_score);
  document.querySelectorAll('.overall-score-num').forEach(el => el.textContent = d.overall_score);
  const interp = document.querySelector('.overall-score-interp');
  if (interp && d.score_interpretation) interp.textContent = d.score_interpretation;

  // Celebration card stats
  const celStats = document.querySelectorAll('.ob-cel-stat-val');
  if (celStats[0]) celStats[0].textContent = d.overall_score;
  if (d.scores && celStats[1] && celStats[2]) {
    const entries = Object.entries(d.scores);
    const best = entries.reduce((a, b) => b[1] > a[1] ? b : a);
    const worst = entries.reduce((a, b) => b[1] < a[1] ? b : a);
    celStats[1].textContent = best[1];
    celStats[2].textContent = worst[1];
    const bestLbl  = celStats[1].closest('.ob-cel-stat')?.querySelector('.ob-cel-stat-lbl');
    const worstLbl = celStats[2].closest('.ob-cel-stat')?.querySelector('.ob-cel-stat-lbl');
    if (bestLbl)  bestLbl.textContent  = 'Best: ' + best[0].charAt(0).toUpperCase() + best[0].slice(1);
    if (worstLbl) worstLbl.textContent = 'Fix: '  + worst[0].charAt(0).toUpperCase() + worst[0].slice(1);
  }

  // Individual dimension scores
  if (d.scores) {
    const order = ['structure', 'conflict', 'dialogue', 'pacing', 'visual'];
    const srNums = document.querySelectorAll('.sr-num');
    const srFills = document.querySelectorAll('.sr-bar-fill');
    const scatScores = document.querySelectorAll('.scat-score');
    order.forEach((dim, i) => {
      const score = d.scores[dim];
      if (score === undefined) return;
      if (srNums[i])    srNums[i].textContent    = score;
      if (scatScores[i]) scatScores[i].textContent = score;
      if (srFills[i])   srFills[i].style.width   = score + '%';
    });
  }

  // Win statement
  const winEl = document.getElementById('win-text');
  if (winEl && d.win_statement) winEl.textContent = d.win_statement;

  // Logline
  const loglineEl = document.getElementById('logline-text');
  if (loglineEl && d.logline) loglineEl.value = '"' + d.logline + '"';

  // Story DNA
  if (d.story_dna && d.story_dna.length) {
    const dnaRows = document.querySelectorAll('.dna-item-row');
    d.story_dna.slice(0, 3).forEach((item, i) => {
      if (!dnaRows[i]) return;
      const inp  = dnaRows[i].querySelector('input');
      const fill = dnaRows[i].querySelector('.dna-bar-fill');
      const pct  = dnaRows[i].querySelector('.dna-pct');
      if (inp)  inp.value        = item.film;
      if (fill) fill.style.width = item.pct + '%';
      if (pct)  pct.textContent  = item.pct + '%';
    });
  }

  // Pacing heatmap — rebuild with real scores
  if (d.pacing_scores && d.pacing_scores.length) {
    window.pacingScores = d.pacing_scores;
    buildHeatmap();
  }

  // Category notes
  if (d.categories) {
    const catMap = {
      structure: 'cat-structure',
      conflict:  'cat-conflict',
      dialogue:  'cat-dialogue',
      pacing:    'cat-pacing',
      visual:    'cat-visual',
    };
    Object.entries(catMap).forEach(([dim, catId]) => {
      const cat = d.categories[dim];
      if (!cat) return;
      const card = document.getElementById(catId);
      if (!card) return;

      // Score inside the category card header
      const burnOld = card.querySelector('.score-burn-old');
      if (burnOld && d.scores) burnOld.textContent = d.scores[dim];

      // Strength note
      const strengthEl = card.querySelector('.note2.w p');
      if (strengthEl && cat.strength) strengthEl.textContent = cat.strength;

      // Flag note
      const flagEl = card.querySelector('.note2.x p');
      if (flagEl && cat.flag) flagEl.textContent = cat.flag;

      // Evidence
      const evEl = card.querySelector('.ev-text');
      if (evEl && cat.evidence) evEl.textContent = '"' + cat.evidence + '"';

      // Fix suggestion
      const fixEl = card.querySelector('.fix2 p');
      if (fixEl && cat.fix) fixEl.textContent = cat.fix;

      // Page reference badges
      card.querySelectorAll('.note2-page').forEach(el => {
        if (cat.page_ref) el.textContent = cat.page_ref;
      });

      // Confidence badge
      const confEl = card.querySelector('.conf-badge');
      if (confEl && cat.confidence) {
        confEl.className = 'conf-badge cb-' + cat.confidence.slice(0,3);
        confEl.textContent = cat.confidence.charAt(0).toUpperCase() + cat.confidence.slice(1);
      }

      // Fix It inline editor — update button label, header, store context, restore saved edits
      const edId = 'ed-' + dim;
      const edEl = document.getElementById(edId);
      if (edEl) {
        // Header label
        const edEye = edEl.querySelector('.ed-eye');
        const dimLabel = dim.charAt(0).toUpperCase() + dim.slice(1);
        if (edEye) edEye.textContent = 'Editing — ' + dimLabel + (cat.page_ref ? ' · ' + cat.page_ref : '');
        // Store original flag/fix so reanalyze() can pass them to the edge function
        if (cat.flag) edEl.dataset.flag = cat.flag;
        if (cat.fix) edEl.dataset.fix = cat.fix;
        // Clear hardcoded demo content; restore any saved edit from localStorage
        const edTa = edEl.querySelector('.ed-ta');
        if (edTa && !edTa.dataset.userEdited) {
          const savedKey = 'so_edit_' + (_currentUser?.id || 'anon') + '_' + dim;
          const saved = localStorage.getItem(savedKey);
          edTa.value = saved || '';
          if (saved) edTa.dataset.userEdited = '1';
          if (!edTa.dataset.listenerAttached) {
            edTa.dataset.listenerAttached = '1';
            edTa.addEventListener('input', () => {
              edTa.dataset.userEdited = '1';
              const k = 'so_edit_' + (_currentUser?.id || 'anon') + '_' + dim;
              localStorage.setItem(k, edTa.value);
            });
          }
        }
      }
      // Fix It button label
      const fixBtn = card.querySelector('.fixit-btn span');
      if (fixBtn) fixBtn.textContent = cat.page_ref ? 'inline editor · ' + cat.page_ref : 'inline editor';
    });
  }

  // Revision plan
  if (d.revision_plan && d.revision_plan.length) {
    const revItems = document.querySelectorAll('.rev-item');
    d.revision_plan.slice(0, 3).forEach((item, i) => {
      if (!revItems[i]) return;
      const titleEl = revItems[i].querySelector('.rev-content-title');
      const descEl  = revItems[i].querySelector('.rev-content-desc');
      const impactEl = revItems[i].querySelector('.rev-impact');
      if (titleEl && item.title)       titleEl.textContent = item.title;
      if (descEl  && item.description) descEl.textContent  = item.description;
      if (impactEl && item.impact)     impactEl.textContent = item.impact;
    });
  }

  // Top stats row — overall score
  const topStatVals = document.querySelectorAll('.top-stat-val');
  if (topStatVals[0] && d.overall_score) topStatVals[0].textContent = d.overall_score;

  // Overall score subtitle + badge
  const interpSub = document.getElementById('overall-score-interp-sub');
  if (interpSub && d.score_interpretation) interpSub.textContent = d.score_interpretation;

  // Top Strength — highest scoring dimension
  if (d.scores && d.categories) {
    const dims = ['structure','conflict','dialogue','pacing','visual'];
    const sorted = dims.slice().sort((a,b) => (d.scores[b]||0) - (d.scores[a]||0));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    const strengthVal = document.getElementById('top-strength-val');
    const strengthSub = document.getElementById('top-strength-sub');
    const strengthBadge = document.getElementById('top-strength-badge');
    if (strengthVal) strengthVal.textContent = best.charAt(0).toUpperCase() + best.slice(1);
    if (strengthSub) {
      const bScore = d.scores[best] || '';
      const bRef = d.categories[best]?.page_ref || '';
      strengthSub.textContent = bScore ? ('Score ' + bScore + (bRef ? ' · ' + bRef : '')) : (bRef || '');
    }
    if (strengthBadge) {
      const conf = d.categories[best]?.confidence || 'high';
      strengthBadge.textContent = '↑ ' + conf.charAt(0).toUpperCase() + conf.slice(1) + ' confidence';
    }

    // Biggest Flag — lowest scoring dimension
    const flagVal = document.getElementById('flag-dim-val');
    const flagSub = document.getElementById('pacing-flag-sub');
    const flagBadge = document.getElementById('pacing-flag-badge');
    if (flagVal) flagVal.textContent = worst.charAt(0).toUpperCase() + worst.slice(1);
    if (flagSub) {
      const wScore = d.scores[worst] || '';
      const wRef = d.categories[worst]?.page_ref || '';
      flagSub.textContent = wScore ? ('Score ' + wScore + (wRef ? ' · ' + wRef : '')) : (wRef || '');
    }
    if (flagBadge) {
      const flag = d.categories[worst]?.flag || '';
      flagBadge.textContent = flag ? '⚠ ' + flag.split('.')[0].slice(0, 40) : '⚠ Needs attention';
    }

    // Overall badge — name the best dimension
    const overallBadge = document.getElementById('overall-score-badge');
    if (overallBadge) overallBadge.textContent = '↑ Strong ' + best;
  }

  // ── Script Highlights (writer profile feed) ──────────────────────────────
  // Populate 4 items from real analysis: top strength, STC beat, dialogue, worst flag
  if (d.categories && d.scores) {
    const dimLabel = { structure:'Structure', conflict:'Conflict', dialogue:'Dialogue', pacing:'Pacing', visual:'Visual' };
    const scored = Object.entries(d.scores).filter(([,v]) => typeof v === 'number').sort((a,b) => b[1]-a[1]);
    const bestDim  = scored[0]?.[0];
    const worstDim = scored[scored.length-1]?.[0];
    const dlgCat   = d.categories.dialogue;
    const bestCat  = bestDim ? d.categories[bestDim] : null;
    const worstCat = worstDim ? d.categories[worstDim] : null;

    const _hl = (titleId, descId, pageId, title, desc, page) => {
      const t = document.getElementById(titleId); if (t) t.textContent = title || '—';
      const d2 = document.getElementById(descId);  if (d2) d2.textContent = desc || '';
      const p = document.getElementById(pageId);  if (p) p.textContent = page || '';
    };

    // 1. Best dimension strength
    _hl('hl1-title', 'hl1-desc', 'hl1-page',
      (dimLabel[bestDim] || '') + ' — strength',
      bestCat?.strength?.split('.')[0] || '',
      (bestCat?.page_ref ? bestCat.page_ref + ' · ' : '') + (dimLabel[bestDim] || '') + ' ✅'
    );

    // 2. Save the Cat strongest beat
    const stcBeat = d.save_the_cat?.strongest_beat || '';
    const stcRef  = stcBeat.match(/pp?\.\s*[\d–\-]+/i)?.[0] || '';
    const stcName = stcBeat.split(/\s[—–-]\s/)[0]?.trim().slice(0, 40) || 'Strong beat';
    const stcDesc = stcBeat.split(/\s[—–-]\s/).slice(1).join(' — ').slice(0, 80) || stcBeat.slice(0, 80);
    _hl('hl2-title', 'hl2-desc', 'hl2-page', stcName, stcDesc, (stcRef ? stcRef + ' · ' : '') + 'Structure ✅');

    // 3. Dialogue strength
    _hl('hl3-title', 'hl3-desc', 'hl3-page',
      'Dialogue — ' + (dlgCat?.confidence || 'note'),
      dlgCat?.strength?.split('.')[0] || '',
      (dlgCat?.page_ref ? dlgCat.page_ref + ' · ' : '') + 'Dialogue ✅'
    );

    // 4. Worst dimension flag
    _hl('hl4-title', 'hl4-desc', 'hl4-page',
      (dimLabel[worstDim] || '') + ' gap flagged',
      worstCat?.flag?.split('.')[0] || '',
      (worstCat?.page_ref ? worstCat.page_ref + ' · ' : '') + (dimLabel[worstDim] || '') + ' ⚠'
    );
  }
}

// ─── NAV ───
// Screens worth restoring after a browser refresh (excludes transient auth/onboarding screens)
const _PERSISTENT_SCREENS = new Set(['upload','report','dashboard','exec-profile','writer-profile','requests']);

function goTo(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+id).classList.add('active');
  window.scrollTo(0,0);
  if (_PERSISTENT_SCREENS.has(id)) {
    try { sessionStorage.setItem('so_last_screen', id); } catch(_){}
  }
  if (id === 'upload') {
    const btn = document.getElementById('analyze-btn');
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = 'Analyze Script';
      if (_uploadedFile) btn.classList.add('ready');
    }
    loadScriptHistory();
  }
  if (id === 'dashboard') { loadDashboard(); _startDashRealtime(); } else { _stopDashRealtime(); }
  if (id === 'requests') loadRequestsScreen();
  if (id === 'exec-profile') loadExecProfile();
  if (id === 'report') syncRepBarHeight();
  if (id === 'welcome') setTimeout(_tsRenderWriterForms, 150);
  // exec Turnstile widgets render on submit, not on screen load (avoids focus-steal on mobile)
}

// ─── Cloudflare Turnstile ────────────────────────────────────────────────────
const _TS_SITE_KEY = '0x4AAAAADrnusj8lT1xi7OE';
const _tsWidgets = {};
const _tsTokens = {};

// Called by Turnstile script once loaded — pre-render writer forms only (exec forms render on submit to avoid focus-steal on mobile)
function onTurnstileLoad() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  if (active.id === 'screen-welcome') _tsRenderWriterForms();
}

function _tsMakeOpts(key) {
  return {
    sitekey: _TS_SITE_KEY,
    appearance: 'always',
    theme: 'dark',
    callback:          (t) => { _tsTokens[key] = t; },
    'expired-callback':()  => { _tsTokens[key] = null; },
    'error-callback':  ()  => { _tsTokens[key] = null; },
  };
}

function _tsRender(containerId, key) {
  if (!window.turnstile) return;
  const el = document.getElementById(containerId);
  if (!el) return;
  // If already rendered and iframe is present, skip
  if (_tsWidgets[key] !== undefined && el.querySelector('iframe')) return;
  // Previous render attempt failed (hidden element) — clean up and retry
  if (_tsWidgets[key] !== undefined) {
    try { turnstile.remove(_tsWidgets[key]); } catch(e){}
    delete _tsWidgets[key];
    el.innerHTML = '';
  }
  _tsWidgets[key] = turnstile.render(el, _tsMakeOpts(key));
}

function _tsReset(key) {
  _tsTokens[key] = null;
  if (window.turnstile && _tsWidgets[key] !== undefined) {
    turnstile.reset(_tsWidgets[key]);
  }
}

function _tsGetToken(key) { return _tsTokens[key] || null; }

// Wait up to maxMs for Turnstile to auto-complete; resolves with token or null
function _tsAwaitToken(key, maxMs = 5000) {
  return new Promise(resolve => {
    if (_tsTokens[key]) { resolve(_tsTokens[key]); return; }
    const start = Date.now();
    const poll = setInterval(() => {
      if (_tsTokens[key]) { clearInterval(poll); resolve(_tsTokens[key]); }
      else if (Date.now() - start > maxMs) { clearInterval(poll); resolve(null); }
    }, 100);
  });
}

function _tsRenderWriterForms() {
  _tsRender('ts-writer-signup', 'writerSignup');
  _tsRender('ts-writer-login',  'writerLogin');
}

function _tsRenderExecForms() {
  _tsRender('ts-exec-signup', 'execSignup');
  _tsRender('ts-exec-signin', 'execSignin');
}

// Keep the score sidebar pinned just below the (sticky) report top bar
function syncRepBarHeight(){
  const b = document.querySelector('.rep-bar');
  if (b && b.offsetHeight) document.documentElement.style.setProperty('--rep-bar-h', b.offsetHeight + 'px');
}
window.addEventListener('resize', syncRepBarHeight);

// ─── UPLOAD ───
const dz=document.getElementById('drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('over');const f=e.dataTransfer.files[0];if(f)setFile(f);});





// ─── PROCESSING ───
const readingPhrases = [
  'Parsing script into scenes and acts...',
  'Identifying characters and arcs...',
  'Act I break found — page 12',
  'Tracking protagonist motivation...',
  'Analyzing dialogue patterns...',
  'Measuring pacing across all pages...',
  'Flagging redundant beats...',
  'Gathering evidence — strongest lines...',
  'Evaluating visual storytelling...',
  'Compiling your script feedback report...',
  '"Scene Set. Your report is ready."'
];

const clapperPhrases = [
  'Slating your script...','Parsing structure...','Identifying characters...',
  'Analyzing act breaks...','Tracking dialogue...','Measuring pacing...',
  'Gathering evidence...','Compiling coverage...','Almost there...'
];

const countdownPhrases = [
  'Loading your script...','Parsing structure...','Identifying characters...',
  'Analyzing conflict...','Tracking dialogue...','Measuring pacing...',
  'Gathering evidence...','Compiling report...','Final checks...'
];

// ── Screenplay Typewriter ──
function runTypewriter(){
  document.getElementById('loader-typewriter').classList.add('active');
  document.getElementById('loader-countdown').classList.remove('active');
  document.getElementById('loader-clapper').classList.remove('active');
  document.getElementById('loader-spotlight').classList.remove('active');

  const title = (window._uploadedTitle || 'UNTITLED').toUpperCase();
  const content = document.getElementById('tw-content');
  const label = document.getElementById('tw-label');
  const paper = document.getElementById('tw-paper');
  content.innerHTML = '';
  paper.scrollTop = 0;

  const lines = [
    { cls:'tw-slug', text:'FADE IN:' },
    { cls:'tw-slug', text:'' },
    { cls:'tw-slug', text:'INT. DEVELOPMENT OFFICE — DAY' },
    { cls:'tw-action', text:'' },
    { cls:'tw-action', text:'A screenplay sits on a desk. Pages weathered from rewrites.' },
    { cls:'tw-action', text:'Someone, finally, is paying attention.' },
    { cls:'tw-action', text:'' },
    { cls:'tw-slug', text:'EXT. THE SYSTEM — CONTINUOUS' },
    { cls:'tw-action', text:'' },
    { cls:'tw-action', text:'SceneOne parses the structure. Act breaks emerge. Characters' },
    { cls:'tw-action', text:'take shape. Dialogue is weighed against subtext.' },
    { cls:'tw-action', text:'' },
    { cls:'tw-char', text:'ALGORITHM' },
    { cls:'tw-paren', text:'(reading carefully)' },
    { cls:'tw-dialogue', text:`"${title}." This one has something.` },
    { cls:'tw-action', text:'' },
    { cls:'tw-slug', text:'INT. ANALYSIS ENGINE — MOMENTS LATER' },
    { cls:'tw-action', text:'' },
    { cls:'tw-action', text:'Evidence gathered. Scores compiled. The craft examined' },
    { cls:'tw-action', text:'across five dimensions. The report is almost ready.' },
  ];

  const phrases = ['Reading your script...','Parsing act structure...','Identifying characters...','Analyzing dialogue...','Measuring pacing...','Gathering evidence...','Compiling your report...'];
  let pi = 0;
  const phraseInt = setInterval(()=>{ if(pi < phrases.length) label.textContent = phrases[pi++]; }, 2600);

  let li = 0, ci = 0;
  let currentEl = null;

  function typeLine(){
    if(li >= lines.length) return;
    const { cls, text } = lines[li];
    if(ci === 0){
      currentEl = document.createElement('p');
      currentEl.className = cls;
      currentEl.style.margin = '0';
      currentEl.textContent = '';
      content.appendChild(currentEl);
    }
    if(ci < text.length){
      currentEl.textContent += text[ci];
      ci++;
      // Scroll paper up as content grows
      paper.scrollTop = paper.scrollHeight;
      const delay = text[ci-1] === ' ' ? 40 : (Math.random() > 0.85 ? 120 : 45);
      setTimeout(typeLine, delay);
    } else {
      li++; ci = 0;
      setTimeout(typeLine, li < lines.length && lines[li]?.text === '' ? 80 : 180);
    }
  }
  typeLine();
  runProgressBar(readingPhrases, 18000, '"The page is read. Your report is ready."', ()=>clearInterval(phraseInt));
}

// ── Spotlight / Noir ──
function runSpotlight(){
  document.getElementById('loader-spotlight').classList.add('active');
  document.getElementById('loader-typewriter').classList.remove('active');
  document.getElementById('loader-countdown').classList.remove('active');
  document.getElementById('loader-clapper').classList.remove('active');

  // Dust particles
  const dustEl = document.getElementById('spot-dust');
  dustEl.innerHTML = '';
  for(let i=0;i<40;i++){
    const p=document.createElement('div'); p.className='spot-dust-p';
    p.style.cssText=`--dd:${4+Math.random()*8}s;--dl:${Math.random()*6}s;--dl2:${20+Math.random()*60}%;`;
    dustEl.appendChild(p);
  }

  const phrases = [
    { main:'Reading your pages.', sub:'Parsing script structure' },
    { main:'Mapping the acts.', sub:'Identifying story beats' },
    { main:'Every character has a secret.', sub:'Analyzing character arcs' },
    { main:'What does the dialogue hide?', sub:'Examining subtext' },
    { main:'Scene by scene. Beat by beat.', sub:'Measuring pacing' },
    { main:'The story reveals itself.', sub:'Visual storytelling analysis' },
    { main:'Gathering the evidence.', sub:'Compiling findings' },
    { main:'Your report is almost ready.', sub:'Finalizing scores' },
  ];

  const phraseEl = document.getElementById('spot-phrase');
  const subEl = document.getElementById('spot-sub');
  let pi = 0;

  function nextPhrase(){
    if(pi >= phrases.length) return;
    phraseEl.classList.add('fade');
    setTimeout(()=>{
      phraseEl.textContent = phrases[pi].main;
      subEl.textContent = phrases[pi].sub;
      phraseEl.classList.remove('fade');
      pi++;
      if(pi < phrases.length) setTimeout(nextPhrase, 2200 + Math.random()*600);
    }, 400);
  }
  setTimeout(nextPhrase, 600);
  runProgressBar(readingPhrases, 18000, '"Lights up. Your script report is ready."');
}

// ── Film Countdown ──
function runCountdown(){
  document.getElementById('loader-countdown').classList.add('active');
  document.getElementById('loader-clapper').classList.remove('active');
  document.getElementById('loader-typewriter').classList.remove('active');
  document.getElementById('loader-spotlight').classList.remove('active');

  let count = 8;
  const numEl = document.getElementById('cd-num');
  const tickerEl = document.getElementById('cd-ticker');
  const readingEl = document.getElementById('cd-reading');
  const blipEl = document.getElementById('cd-blip');

  function tick(){
    // Animate number
    numEl.style.animation = 'none';
    numEl.offsetHeight; // reflow
    numEl.style.animation = 'num-pop .15s ease-out';
    numEl.textContent = count;
    tickerEl.textContent = `00:00:0${count > 9 ? count : '0'+count}:00`;

    // Blip on each number
    blipEl.style.display = 'block';
    blipEl.style.animation = 'none';
    blipEl.offsetHeight;
    blipEl.style.animation = 'blip-flash .5s ease-out forwards';
    setTimeout(()=>blipEl.style.display='none', 500);

    count--;
    if(count > 0) setTimeout(tick, 1000);
    else {
      numEl.textContent = '';
      tickerEl.textContent = '';
    }
  }
  tick();

  // Reading phrases cycle after countdown
  let pi = 0;
  function cycleReading(){
    if (readingEl && pi < countdownPhrases.length){
      readingEl.textContent = countdownPhrases[pi++];
      setTimeout(cycleReading, 1700 + Math.random()*700);
    }
  }
  setTimeout(cycleReading, 9000);

  runProgressBar(countdownPhrases, 18000, '"Scene Set. Action."');
}

// ── Clapperboard ──
function runClapper(){
  document.getElementById('loader-countdown').classList.remove('active');
  document.getElementById('loader-clapper').classList.add('active');
  document.getElementById('loader-typewriter').classList.remove('active');
  document.getElementById('loader-spotlight').classList.remove('active');

  // Set script title on clapperboard
  const title = document.getElementById('crawl-title')?.textContent || 'THE LAST HOUR';
  document.getElementById('clapper-title').textContent = title;
  document.getElementById('clapper-scene').textContent = title.substring(0,8);

  const arm = document.getElementById('clapper-arm');
  const readingEl = document.getElementById('clapper-reading');
  const completeEl = document.getElementById('clapper-complete');

  // Arm slap after 1.5s
  setTimeout(()=>{
    arm.classList.add('slap');
  }, 1500);

  // Reading phrases
  let pi = 0;
  function cycleReading(){
    if(pi < clapperPhrases.length){
      readingEl.textContent = clapperPhrases[pi++];
      setTimeout(cycleReading, 1700 + Math.random()*700);
    }
  }
  setTimeout(cycleReading, 2500);

  // Take counter ticks up
  let take = 1;
  const takeEl = document.getElementById('clapper-take');
  const takeInt = setInterval(()=>{
    take++;
    takeEl.textContent = take;
    if(take >= 9) clearInterval(takeInt);
  }, 2000);

  runProgressBar(clapperPhrases, 18000, '"Cut. Your script report is ready."', ()=>{
    completeEl.classList.add('show');
    clearInterval(takeInt);
  });
}

// ── Shared progress bar ──


// ─── HEATMAP ───
function buildHeatmap(){
  const grid=document.getElementById('heatmap');
  const legend=document.getElementById('hm-legend');
  const tip=document.getElementById('hm-tip');
  if (!grid) return;
  grid.innerHTML = '';
  if (legend) legend.innerHTML = '';
  // Use real pacing scores from API if available, otherwise use demo data
  const scores = window.pacingScores && window.pacingScores.length ? window.pacingScores : [
    85,88,90,86,82,80,78,84,87,89,
    85,83,79,76,72,68,65,63,60,58,
    62,64,60,58,55,52,54,56,60,63,
    58,55,52,48,45,44,46,50,54,57,
    60,63,66,70,72,74,71,68,65,62,
    65,68,72,75,78,80,83,86,84,82,
    79,76,73,70,68,65,68,72,75,78,
    82,85,88,86,84,87,90,88,85,82,
    86,88,91,92,90,88,86,84,82,80,
    83,85,87,84
  ];
  const pageLabels=['Opening — strong setup','Character intro — good pace','Inciting incident','Rising tension','Rising tension','Protagonist goal set','Conflict emerges','Stakes raised','Mentor introduced','Act I building',
    'Act I climax','Act I break — p.15','Transition','Early Act II','Rising complication','Hesitation begins — slows','Hesitation continues','Pacing gap starts','Pacing gap — slow','Pacing gap — slow',
    'Pacing gap deepens','Slow — three beats repeat','Pacing gap peak','Slow sequence','Slowest point','Slowest point — p.43','Slight pickup','Recovery begins','Picking up','Momentum returning',
    'Midpoint approaching','Midpoint — p.55','Post-midpoint','New direction','Building again','Rising','Rising tension','Conflict escalates','Escalating','Rising',
    'Strong Act II push','Building','Building momentum','Strong sequence','Rising','Rising','Slight dip','Recovering','Building','Building',
    'Strong push','Building','Rising tension','Act II climax building','High tension','High tension','Strong momentum','Cresting','Pre-climax','Strong',
    'Pre-climax','Tension peaks','High stakes','High stakes','Crisis point','Darkest moment','Recovery','Rising action','Building to climax','Climax building',
    'Climax approach','Climax approach','Climax begins','Climax','Full climax — p.86','Climax peak','Resolution begins','Resolution','Falling action','Denouement',
    'Wrap — p.90','Final moments','Final moments','End'
  ];
  // Color scale: deep orange (slow) → neutral → bright cyan (strong)
  const getColor=(v)=>{
    if(v>=80)return`rgba(62,237,231,${.2+(v-80)*.028})`; // bright cyan — strong momentum
    if(v>=65)return`rgba(62,237,231,${.08+(v-65)*.008})`; // faint cyan — good
    if(v>=50)return`rgba(232,146,58,${.15+(65-v)*.015})`; // faint orange — below avg
    return`rgba(232,100,30,${.45+(50-v)*.02})`; // deep orange — slow/flagged
  };
  scores.forEach((s,i)=>{
    const cell=document.createElement('div');
    cell.className='hm-cell';
    cell.style.background=getColor(s);
    cell.style.outline='1px solid rgba(255,255,255,0.04)';
    const pg=i+1;
    cell.addEventListener('mouseenter',e=>{
      tip.style.display='block';
      tip.innerHTML=`<strong>p.${pg}</strong> · ${pageLabels[i]||''}<br><span style="color:var(--cyan)">${s}/100</span>`;
      const r=cell.getBoundingClientRect();
      const pr=document.getElementById('heatmap').closest('.heatmap-card').getBoundingClientRect();
      tip.style.left=(r.left-pr.left)+'px';
      tip.style.top=(r.top-pr.top-38)+'px';
    });
    cell.addEventListener('mouseleave',()=>tip.style.display='none');
    grid.appendChild(cell);
  });
  // legend
  const steps=['rgba(232,100,30,0.8)','rgba(232,146,58,0.4)','rgba(150,150,150,0.2)','rgba(62,237,231,0.35)','rgba(62,237,231,0.65)'];
  steps.forEach(c=>{
    const lc=document.createElement('div'); lc.className='hm-legend-cell'; lc.style.background=c;
    legend.appendChild(lc);
  });
}
buildHeatmap();

// ─── REPORT INTERACTIONS ───
function toggleCat(head){
  head.classList.toggle('open');
  head.nextElementSibling.classList.toggle('open');
  const id=head.closest('.cat-card').id;
  const map={cat:0,'cat-structure':0,'cat-conflict':1,'cat-dialogue':2,'cat-pacing':3,'cat-visual':4};
  document.querySelectorAll('.scat').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.score-row2').forEach(s=>s.classList.remove('active'));
  const idx=map[id];
  if(idx!==undefined){
    document.querySelectorAll('.scat')[idx]?.classList.add('active');
    document.querySelectorAll('.score-row2')[idx]?.classList.add('active');
  }
}

function toggleEd(id){
  const ed = document.getElementById(id);
  ed.classList.toggle('open');
  if (ed.classList.contains('open')) {
    // Visual clap flash
    ed.style.animation = 'none';
    ed.offsetHeight;
    ed.style.animation = 'fU .2s ease';
    // Flash the Fix It label like a clapper
    const lbl = ed.querySelector('.ed-eye');
    if (lbl) {
      lbl.style.animation = 'none';
      lbl.offsetHeight;
      lbl.style.cssText += ';animation:clapper-flash .3s ease;';
      if (!document.getElementById('clapper-flash-style')) {
        const st = document.createElement('style');
        st.id = 'clapper-flash-style';
        st.textContent = "@keyframes clapper-flash{0%{color:#fff;letter-spacing:3px;}50%{color:var(--cyan);letter-spacing:5px;}100%{color:var(--cyan);letter-spacing:normal;}}";
        document.head.appendChild(st);
      }
    }
  }
}
async function reanalyze(edId, dimension) {
  const edEl = document.getElementById(edId);
  const ta = edEl?.querySelector('.ed-ta');
  const btn = edEl?.querySelector('.re-btn');
  const fb = document.getElementById('rf-' + dimension);
  if (!ta || !btn || !edEl) return;

  const text = ta.value.trim();
  if (!text) {
    if (fb) { fb.className = 're-feedback needs-work show'; fb.innerHTML = '<div class="re-fb-verdict">⚠ Nothing to analyze</div><div class="re-fb-text">Write your revised scene in the editor first.</div>'; }
    return;
  }

  const origLabel = btn.textContent;
  btn.textContent = 'Analyzing…';
  btn.disabled = true;
  if (fb) { fb.className = 're-feedback'; fb.innerHTML = ''; }

  try {
    const { data, error } = await supabaseClient.functions.invoke('grade-scene', {
      body: {
        scene_text: text,
        dimension: dimension,
        original_flag: edEl.dataset.flag || '',
        original_fix: edEl.dataset.fix || '',
      }
    });

    if (error || data?.error) throw new Error((error?.message || data?.error) || 'Unknown error');

    if (fb) {
      const cls = data.improved ? 'improved' : 'needs-work';
      const verdict = data.improved ? '✓ Improved' : '↻ Keep Revising';
      fb.className = 're-feedback ' + cls + ' show';
      fb.innerHTML = `<div class="re-fb-verdict">${esc(verdict)}</div><div class="re-fb-text">${esc(data.assessment || '')}</div>${data.next_step ? '<div class="re-fb-next">Next: ' + esc(data.next_step) + '</div>' : ''}`;
    }
  } catch (err) {
    console.error('SceneOne reanalyze error:', err);
    if (fb) { fb.className = 're-feedback needs-work show'; fb.innerHTML = '<div class="re-fb-verdict">⚠ Error</div><div class="re-fb-text">' + esc(err.message || 'Could not get feedback. Try again.') + '</div>'; }
  } finally {
    btn.textContent = origLabel;
    btn.disabled = false;
  }
}

function copyScene(edId) {
  const ta = document.querySelector('#' + edId + ' .ed-ta');
  const btn = document.querySelector('#' + edId + ' .cp-btn');
  if (!ta || !ta.value.trim()) return;
  navigator.clipboard.writeText(ta.value.trim()).catch(() => {});
  if (btn) {
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }
}

function scrollTo2(id){
  const el=document.getElementById(id);
  if(!el)return;
  el.scrollIntoView({behavior:'smooth',block:'start'});
  const h=el.querySelector('.cat-head'),b=el.querySelector('.cat-body2');
  if(h&&!h.classList.contains('open')){h.classList.add('open');b.classList.add('open');}
  const map={'cat-structure':0,'cat-conflict':1,'cat-dialogue':2,'cat-pacing':3,'cat-visual':4};
  document.querySelectorAll('.scat').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.score-row2').forEach(s=>s.classList.remove('active'));
  const idx=map[id];
  if(idx!==undefined){
    document.querySelectorAll('.scat')[idx]?.classList.add('active');
    document.querySelectorAll('.score-row2')[idx]?.classList.add('active');
  }
}
// open first cat on load
document.querySelector('#cat-structure .cat-head')?.classList.add('open');
document.querySelector('#cat-structure .cat-body2')?.classList.add('open');

// ─── ONBOARDING ───
let isFirstTime = true;
let userName = '';
let currentTourStep = 0;

const tourSteps = [
  { eye:'✦ Win Statement', title:'This loads first. Always.', body:"Before any score, SceneOne surfaces one specific thing your script does well — with a page reference. Not encouragement. Evidence.", target:'.win-card', pos:'below' },
  { eye:'📊 Score Overview', title:'Five dimensions. All craft.', body:'Structure, Conflict, Dialogue, Pacing, Visual Storytelling. Every score is based on documented craft fundamentals — never taste or opinion.', target:'.scores-card', pos:'right' },
  { eye:'🗺 Pacing Heatmap', title:'See your dead zones instantly.', body:'Every page scored and color-coded. Dark navy = slow. Bright cyan = strong momentum. Hover any cell for details.', target:'.heatmap-card', pos:'left' },
  { eye:'🔧 Fix It', title:"Don't just read the note. Fix it here.", body:'Every flagged issue has a Fix It button. Opens an inline editor for just that scene. Edit, re-analyze, score updates in seconds.', target:'#cat-pacing', pos:'above' },
  { eye:'📋 Revision Plan', title:'Your top 3 highest-impact fixes.', body:"SceneOne ranks the fixes that will move your score the most. Not a list of everything — a prioritized action plan.", target:'.rev-card', pos:'above' }
];

async function startOnboarding() {
  const nameEl = document.getElementById('ob-name');
  const emailEl = document.getElementById('ob-email');
  const passEl = document.getElementById('ob-password');
  const btn = document.getElementById('signup-submit');
  const name = nameEl?.value?.trim() || '';
  const email = emailEl?.value?.trim() || '';
  const password = passEl?.value || '';

  if (!email.includes('@')) {
    emailEl.style.borderColor = 'rgba(232,146,58,0.6)';
    emailEl.focus();
    return;
  }

  btn.textContent = 'Creating account…';
  btn.disabled = true;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { full_name: name }, captchaToken: await _tsAwaitToken('writerSignup') }
  });
  _tsReset('writerSignup');

  if (error) {
    btn.textContent = 'Create Account & Continue →';
    btn.disabled = false;
    // Show a generic message regardless of the specific error so we don't leak
    // whether a given email address already has an account (account enumeration).
    const isEmailTaken = error.message?.toLowerCase().includes('already registered')
                      || error.message?.toLowerCase().includes('already exists')
                      || error.status === 422;
    const displayMsg = isEmailTaken
      ? 'An account with that email already exists. <span style="text-decoration:underline;cursor:pointer;" onclick="goTo(\'welcome\');switchAuthTab(\'login\')">Sign in instead?</span>'
      : 'Something went wrong. Please check your details and try again.';
    emailEl.style.borderColor = 'rgba(232,146,58,0.6)';
    emailEl.parentElement.insertAdjacentHTML('afterend',
      `<div style="color:#E8923A;font-size:12px;margin-top:4px;">${displayMsg}</div>`);
    return;
  }

  // If email confirmation is enabled, session is null until confirmed.
  // Force a sign-in immediately so the session persists across reloads.
  if (!data.session) {
    const { data: signInData, error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (!signInError && signInData.session) {
      _currentUser = signInData.user;
    } else {
      // Confirmation email required — tell the user
      btn.textContent = 'Create Account & Continue →';
      btn.disabled = false;
      emailEl.parentElement.insertAdjacentHTML('afterend',
        `<div style="color:var(--cyan);font-size:12px;margin-top:4px;">Check your email to confirm your account, then sign in.</div>`);
      return;
    }
  } else {
    _currentUser = data.user;
  }

  userName = name.split(' ')[0] || email.split('@')[0];
  isFirstTime = true;
  goTo('onboard');
  updateObDots(0);
}

function skipToUpload() {
  isFirstTime = false;
  goTo('upload');
}

function nextObStep(step) {
  document.querySelectorAll('.onboard-step').forEach(s=>s.classList.remove('active'));
  document.getElementById('ob-step-'+step).classList.add('active');
  updateObDots(step);
}

function updateObDots(active) {
  for(let i=0;i<6;i++){
    const dot=document.getElementById('ob-dot-'+i);
    if(!dot) continue;
    dot.classList.remove('active','done');
    if(i<active) dot.classList.add('done');
    else if(i===active) dot.classList.add('active');
  }
}

function finishOnboarding() {
  isFirstTime = true;
  goTo('upload');
  if(userName){
    setTimeout(()=>{
      const desc=document.querySelector('.upload-desc');
      if(desc&&!desc.dataset.greeted){
        desc.innerHTML='<span style="color:var(--cyan);font-weight:700">Welcome, '+esc(userName)+'. </span>'+desc.innerHTML;
        desc.dataset.greeted='1';
      }
    },100);
  }
}

function dismissCelebrate() {
  const cel = document.getElementById('ob-celebrate');
  cel.classList.remove('show');
  cel.style.display = 'none';
}

function dismissCelebrateAndTour() {
  dismissCelebrate();
  setTimeout(()=>launchTour(), 400);
}

function launchTour() {
  currentTourStep = 0;
  const overlay = document.getElementById('ob-tooltip-overlay');
  overlay.style.display = 'block';
  overlay.classList.add('active');
  showTourStep(0);
}

function showTourStep(idx) {
  if(idx>=tourSteps.length){ skipTour(); return; }
  const step=tourSteps[idx];
  const tooltip=document.getElementById('ob-tooltip');
  const ring=document.getElementById('ob-ring');
  document.getElementById('ob-tt-eye').textContent=step.eye;
  document.getElementById('ob-tt-title').textContent=step.title;
  document.getElementById('ob-tt-body').textContent=step.body;
  const target=document.querySelector(step.target);
  if(target){
    const rect=target.getBoundingClientRect();
    ring.style.cssText='position:absolute;border:2px solid var(--cyan);border-radius:12px;box-shadow:0 0 0 4px rgba(62,237,231,0.15);pointer-events:none;transition:all .3s;z-index:5;left:'+(rect.left-4)+'px;top:'+(rect.top+window.scrollY-4)+'px;width:'+(rect.width+8)+'px;height:'+(rect.height+8)+'px;';
    const TW=280,TH=200;
    let tl,tt;
    if(step.pos==='below'){tt=rect.bottom+12;tl=Math.max(16,Math.min(rect.left,window.innerWidth-TW-16));}
    else if(step.pos==='above'){tt=rect.top-TH-12;tl=Math.max(16,Math.min(rect.left,window.innerWidth-TW-16));}
    else if(step.pos==='right'){tt=rect.top;tl=rect.right+12;}
    else{tt=rect.top;tl=rect.left-TW-12;}
    tt=Math.max(16,Math.min(tt,window.innerHeight-TH-16));
    tl=Math.max(16,Math.min(tl,window.innerWidth-TW-16));
    tooltip.style.top=tt+'px'; tooltip.style.left=tl+'px';
    target.scrollIntoView({behavior:'smooth',block:'center'});
  }
  const nb=tooltip.querySelector('.ob-tt-next');
  if(nb) nb.textContent=idx===tourSteps.length-1?'Got it ✓':'Next →';
}



function nextTourStep() {
  currentTourStep++;
  showTourStep(currentTourStep);
}

function skipTour() {
  const overlay = document.getElementById('ob-tooltip-overlay');
  overlay.classList.remove('active');
  overlay.style.display = 'none';
  const ring=document.getElementById('ob-ring');
  if(ring) ring.style.cssText='width:0;height:0;';
}

// Wire landing path buttons and cleanup overlays on load
window.addEventListener('load',()=>{
  const writerBtn = document.getElementById('path-writer-btn');
  const execBtn   = document.getElementById('path-exec-btn');
  if(writerBtn) writerBtn.addEventListener('click', () => {
    if (_currentUser) { goTo('upload'); return; }
    goTo('welcome');
  });
  if(execBtn) execBtn.addEventListener('click', async () => {
    if (_currentUser) {
      // Already signed in — check if this account has exec access
      const { data: profile } = await supabaseClient.from('profiles').select('role,verified').eq('id', _currentUser.id).maybeSingle();
      if (profile?.role === 'exec' && profile?.verified) {
        const hasSeenExecOnboard = localStorage.getItem('sceneone_exec_onboard_done');
        goTo(hasSeenExecOnboard ? 'exec-profile' : 'exec-onboard');
        return;
      }
    }
    // Not logged in, or no exec profile — go to exec auth, default to Sign In tab
    goTo('exec-signup');
    switchExecTab(_currentUser ? 'signup' : 'signin');
  });

  const overlay=document.getElementById('ob-tooltip-overlay');
  if(overlay){ overlay.style.display='none'; overlay.classList.remove('active'); }
  const celebrate=document.getElementById('ob-celebrate');
  if(celebrate){ celebrate.style.display='none'; celebrate.classList.remove('show'); }
});

// ─── SIGN OUT ───
async function handleSignOut() {
  await supabaseClient.auth.signOut();
  _currentUser = null;
  try { sessionStorage.removeItem('so_last_screen'); } catch(_){}
  goTo('landing');
}

// ─── EXEC SIGNUP ───
let _selectedExecRole = '';

function selectExecRole(btn, role) {
  document.querySelectorAll('.exec-role-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _selectedExecRole = role;
}

// ─── DISCOVERY DASHBOARD ───
function setDashSort(s) {
  _dashSort = s;
  document.getElementById('sort-score')?.classList.toggle('active', s === 'score');
  document.getElementById('sort-recent')?.classList.toggle('active', s === 'recent');
  loadDashboard();
}

function showExecComingSoon(label) {
  const existing = document.getElementById('exec-coming-soon-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'exec-coming-soon-toast';
  toast.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1A1A1A;border:1px solid rgba(201,168,76,0.3);border-radius:10px;padding:10px 20px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.7);z-index:9999;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
  toast.textContent = label + ' — coming soon';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

async function loadExecProfile() {
  if (!_currentUser) return;
  // Set first name from metadata or email
  const meta = _currentUser.user_metadata;
  const firstName = (meta?.full_name || meta?.name || _currentUser.email || '').split(/[\s@]/)[0];
  const el = document.getElementById('exec-banner-firstname');
  if (el) el.textContent = firstName ? firstName + '.' : 'there.';

  // Get total publicly listed scripts
  const { count: scriptCount } = await supabaseClient
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'complete')
    .eq('public_listing', true);
  const pillScripts = document.getElementById('exec-pill-scripts');
  if (pillScripts) pillScripts.textContent = (scriptCount || 0) + ' scripts available';

  // Get exec's pending request count
  const pillReqs = document.getElementById('exec-pill-requests');
  if (pillReqs) {
    const { count: reqCount } = await supabaseClient
      .from('read_requests')
      .select('id', { count: 'exact', head: true })
      .eq('exec_user_id', _currentUser.id)
      .eq('status', 'pending');
    pillReqs.textContent = (reqCount || 0) + ' requests pending';
  }
}

let _dashFilterTimer = null;
function debounceDashFilter() {
  clearTimeout(_dashFilterTimer);
  _dashFilterTimer = setTimeout(loadDashboard, 350);
}

function clearDashFilters() {
  const scoreRange = document.getElementById('filter-score-range');
  if (scoreRange) { scoreRange.value = 50; document.getElementById('score-range-val').textContent = '50'; }
  document.querySelectorAll('.filter-genre-cb, .filter-format-cb').forEach(cb => cb.checked = true);
  const compSearch = document.getElementById('filter-comp-search');
  if (compSearch) compSearch.value = '';
  loadDashboard();
}

async function loadDashboard() {
  const feed = document.getElementById('dash-feed-list');
  const meta = document.getElementById('feed-meta');
  if (!feed) return;
  feed.innerHTML = '<div style="padding:48px;text-align:center;color:var(--sub);font-size:13px;">Loading scripts…</div>';

  // Read filter state
  const minScore = parseInt(document.getElementById('filter-score-range')?.value || '50');
  const genreCbs = [...document.querySelectorAll('.filter-genre-cb')];
  const checkedGenres = genreCbs.filter(cb => cb.checked).map(cb => cb.dataset.genre);
  const allGenres = checkedGenres.length === genreCbs.length;
  const compSearch = (document.getElementById('filter-comp-search')?.value || '').trim().toLowerCase();
  const formatCbs = [...document.querySelectorAll('.filter-format-cb')];
  const checkedFormats = formatCbs.filter(cb => cb.checked).map(cb => cb.dataset.format);
  const allFormats = checkedFormats.length === formatCbs.length;

  try {
    let q = supabaseClient
      .from('submissions')
      .select('id, title, created_at, result')
      .eq('status', 'complete')
      .eq('public_listing', true)
      .limit(30);
    if (_dashSort === 'recent') q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) {
      if (meta) meta.textContent = '0 scripts available';
      feed.innerHTML = `<div style="padding:60px 40px;text-align:center;">
        <div style="font-size:32px;margin-bottom:16px;">🎬</div>
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:8px;">No scripts listed yet.</div>
        <div style="font-size:12px;color:var(--sub);line-height:1.7;">Writers opt in from their coverage report.<br>Check back soon — scripts are being graded every day.</div>
        <button class="pricing-modal-btn" onclick="openPricingModal()" style="margin-top:24px;">View Pricing Plans</button>
      </div>`;
      return;
    }

    // Apply client-side filters
    let rows = data.filter(r => r.result?.overall_score != null);
    rows = rows.filter(r => (r.result.overall_score ?? 0) >= minScore);
    if (!allGenres && checkedGenres.length > 0) {
      rows = rows.filter(r => {
        const genre = (r.result.exec?.genre || r.result.genre || '').toLowerCase();
        return checkedGenres.some(g => {
          if (g === 'thriller') return genre.includes('thriller') || genre.includes('drama');
          if (g === 'drama') return genre.includes('drama');
          return genre.includes(g);
        });
      });
    }
    if (!allFormats && checkedFormats.length > 0) {
      rows = rows.filter(r => {
        const pages = r.result.page_count || 0;
        const type = (r.result.script_type || '').toLowerCase();
        return checkedFormats.some(f => {
          if (f === 'short') return type.includes('short') || (pages > 0 && pages < 35);
          if (f === 'pilot') return type.includes('pilot') || type.includes('tv');
          if (f === 'feature') return type.includes('feature') || (!type.includes('short') && !type.includes('pilot') && (pages === 0 || pages >= 35));
          return true;
        });
      });
    }
    if (compSearch) {
      rows = rows.filter(r => (r.result.story_dna || []).some(d => (d.film || '').toLowerCase().includes(compSearch)));
    }

    if (_dashSort === 'score') rows.sort((a,b) => (b.result.overall_score||0) - (a.result.overall_score||0));
    const filterNote = minScore > 50 || !allGenres || !allFormats || compSearch ? ' · Filtered' : '';
    if (meta) meta.textContent = `${rows.length} script${rows.length!==1?'s':''} available · Sorted by ${_dashSort}${filterNote}`;
    feed.innerHTML = rows.map(row => {
      const r = row.result || {};
      const score = r.overall_score || '—';
      const logline = r.logline ? `<div class="script-card-logline">${esc(r.logline)}</div>` : '';
      const dna = (r.story_dna||[]).slice(0,3).map(d=>`<div class="dna-tag">${esc(d.film)} ${esc(String(d.pct))}%</div>`).join('');
      const scores = r.scores || {};
      const bars = Object.entries(scores).slice(0,3).map(([k,v])=>
        `<div class="mini-score">${k.charAt(0).toUpperCase()+k.slice(1)}</div><div class="mini-bar-strip"><div class="mini-bar-strip-fill fill-c" style="width:${v}%"></div></div>`
      ).join('');
      const scoreColor = score>=75?'var(--green)':score>=60?'var(--cyan)':'var(--amber)';
      const listed = new Date(row.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      return `<div class="script-card" data-id="${esc(row.id)}" data-title="${esc(row.title||'')}">
        <div class="script-card-top">
          <div><div class="script-card-title">${esc(row.title||'UNTITLED').toUpperCase()}</div>
          <div class="script-card-genre">SceneOne Verified · Listed ${listed}</div></div>
          <div class="script-card-score" style="color:${scoreColor}">${score}</div>
        </div>
        ${logline}
        <div class="script-card-dna">${dna}</div>
        <div class="script-card-score-bars">${bars}</div>
        <div class="script-card-footer">
          <div class="script-card-stats"><div class="script-stat">SceneOne verified ✓</div></div>
          <button class="request-access-btn">Request Access →</button>
        </div>
      </div>`;
    }).join('');

    // Increment view counts fire-and-forget for all visible cards
    rows.forEach(row => supabaseClient.rpc('increment_view_count', { p_id: row.id }).catch(() => {}));

    // Event delegation for request-access buttons (avoids inline onclick + title injection)
    feed.addEventListener('click', e => {
      const btn = e.target.closest('.request-access-btn');
      if (!btn) return;
      const card = btn.closest('.script-card');
      if (card) requestScriptAccess(card.dataset.id, card.dataset.title, btn);
    }, { once: true });
  } catch(e) {
    console.warn('SceneOne: dashboard load failed', e);
    if (meta) meta.textContent = 'Could not load scripts';
    feed.innerHTML = '<div style="padding:40px;text-align:center;color:var(--sub);font-size:13px;">Failed to load scripts. Try refreshing.</div>';
  }
}

async function requestScriptAccess(id, title, btn) {
  if (!_currentUser) { goTo('exec-signup'); return; }
  const { data: profile } = await supabaseClient.from('profiles').select('role,verified,display_name').eq('id',_currentUser.id).single();
  if (!profile || profile.role !== 'exec' || !profile.verified) { goTo('exec-signup'); return; }
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  try {
    const { data: inserted, error } = await supabaseClient.from('read_requests').insert({
      submission_id: id,
      exec_user_id: _currentUser.id,
      exec_name: profile.display_name || _currentUser.email,
      exec_email: _currentUser.email,
      status: 'pending',
    }).select('id').single();
    if (error) throw error;
    if (btn) { btn.textContent = '✓ Requested'; btn.style.background='rgba(76,175,125,0.2)'; btn.style.color='var(--green)'; btn.style.borderColor='rgba(76,175,125,0.3)'; }
    // Fire-and-forget — email writer
    if (inserted?.id) _notify('request_received', inserted.id);
  } catch(e) {
    console.warn('SceneOne: request insert failed', e);
    if (btn) { btn.textContent = 'Request Access →'; btn.disabled = false; }
  }
}

function _notify(action, requestId) {
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (!session?.access_token) return;
    fetch(NOTIFY_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ action, request_id: requestId }),
    }).catch(() => {});
  });
}

async function loadListingStats(subId) {
  if (!subId) return;
  try {
    const [reqRes, subRes] = await Promise.all([
      supabaseClient.from('read_requests').select('status').eq('submission_id', subId),
      supabaseClient.from('submissions').select('view_count').eq('id', subId).single(),
    ]);
    if (reqRes.error) throw reqRes.error;
    const total = reqRes.data?.length || 0;
    const approved = reqRes.data?.filter(r => r.status === 'approved').length || 0;
    const el = { views: document.getElementById('stat-views'), reqs: document.getElementById('stat-requests'), approved: document.getElementById('stat-approved') };
    if (el.views) el.views.textContent = subRes.data?.view_count ?? 0;
    if (el.reqs) el.reqs.textContent = total;
    if (el.approved) el.approved.textContent = approved;
  } catch(e) {
    console.warn('SceneOne: loadListingStats failed', e);
  }
}

async function handleRequestAction(requestId, action) {
  try {
    const update = { status: action };
    if (action === 'approved') {
      const exp = new Date();
      exp.setDate(exp.getDate() + 14);
      update.expires_at = exp.toISOString();
    }
    await supabaseClient.from('read_requests').update(update).eq('id', requestId);
    _notify('request_resolved', requestId);
    const subId = await _ensureSubId();
    loadRequestCards(subId);
    loadListingStats(subId);
  } catch(e) {
    console.warn('SceneOne: request action failed', e);
  }
}

async function loadRequestCards(subId) {
  const container = document.getElementById('pending-requests-list');
  if (!container || !subId) return;
  const { data } = await supabaseClient
    .from('read_requests')
    .select('id, exec_name, exec_email, status, created_at, expires_at')
    .eq('submission_id', subId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (!data?.length) { container.innerHTML = '<div style="font-size:12px;color:var(--sub);text-align:center;padding:16px;">No requests yet.</div>'; return; }
  const now = Date.now();
  container.innerHTML = data.map(r => {
    const date = new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const expired = r.status === 'approved' && r.expires_at && new Date(r.expires_at).getTime() < now;
    const expiryLabel = r.status === 'approved' && r.expires_at
      ? (expired ? ' · Expired' : ' · Access until ' + new Date(r.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}))
      : '';
    const statusColor = expired ? 'var(--sub)' : r.status==='approved'?'var(--green)':r.status==='declined'?'var(--amber)':'var(--cyan)';
    const statusLabel = expired ? 'Expired' : r.status.charAt(0).toUpperCase()+r.status.slice(1);
    const actions = r.status==='pending'
      ? `<button data-req-id="${esc(r.id)}" data-req-action="approved" class="req-action-btn" style="padding:5px 12px;border-radius:6px;border:none;background:rgba(76,175,125,0.15);color:var(--green);font-size:11px;font-weight:700;cursor:pointer;">Approve</button>
         <button data-req-id="${esc(r.id)}" data-req-action="declined" class="req-action-btn" style="padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--sub);font-size:11px;font-weight:700;cursor:pointer;">Decline</button>`
      : `<span style="font-size:11px;font-weight:700;color:${statusColor}">${statusLabel}${expiryLabel}</span>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;gap:10px;">
      <div><div style="font-size:12px;font-weight:700;color:#fff;">${esc(r.exec_name)}</div><div style="font-size:11px;color:var(--sub);">${esc(r.exec_email)} · ${date}</div></div>
      <div style="display:flex;gap:6px;align-items:center;">${actions}</div>
    </div>`;
  }).join('');
  container.addEventListener('click', e => {
    const btn = e.target.closest('.req-action-btn');
    if (btn) handleRequestAction(btn.dataset.reqId, btn.dataset.reqAction);
  }, { once: true });
}

// ─── EXEC ONBOARDING ───
let _exobStep = 0;
function nextExobStep(n) {
  document.getElementById('exob-step-' + _exobStep).classList.remove('active');
  document.getElementById('exob-dot-' + _exobStep).classList.remove('active');
  _exobStep = n;
  document.getElementById('exob-step-' + n).classList.add('active');
  document.getElementById('exob-dot-' + n).classList.add('active');
  window.scrollTo(0, 0);
}
function skipExecOnboard() {
  localStorage.setItem('sceneone_exec_onboard_done', '1');
  goTo('exec-profile');
}
function finishExecOnboard() {
  localStorage.setItem('sceneone_exec_onboard_done', '1');
  goTo('exec-profile');
  setTimeout(() => showHappyHunting(), 300);
}

function switchExecTab(tab) {
  const isSignup = tab === 'signup';
  document.getElementById('exec-panel-signup').style.display = isSignup ? '' : 'none';
  document.getElementById('exec-panel-signin').style.display = isSignup ? 'none' : '';
  // Turnstile renders on submit, not on tab switch
  document.getElementById('exec-tab-signup').style.cssText = isSignup
    ? 'flex:1;padding:10px;font-size:12px;font-weight:700;background:var(--gold);color:#0F0F0F;border:none;cursor:pointer;transition:all .15s;'
    : 'flex:1;padding:10px;font-size:12px;font-weight:700;background:transparent;color:var(--sub);border:none;cursor:pointer;transition:all .15s;';
  document.getElementById('exec-tab-signin').style.cssText = isSignup
    ? 'flex:1;padding:10px;font-size:12px;font-weight:700;background:transparent;color:var(--sub);border:none;cursor:pointer;transition:all .15s;'
    : 'flex:1;padding:10px;font-size:12px;font-weight:700;background:var(--gold);color:#0F0F0F;border:none;cursor:pointer;transition:all .15s;';
}

async function handleExecSignIn() {
  const email = document.getElementById('exec-signin-email').value.trim();
  const password = document.getElementById('exec-signin-password').value;
  const errEl = document.getElementById('exec-signin-error');
  const btn = document.getElementById('exec-signin-btn');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Enter your email and password.'; errEl.style.display = ''; return; }
  btn.textContent = 'Signing in…'; btn.disabled = true;
  _tsRender('ts-exec-signin', 'execSignin');
  const captchaToken = await _tsAwaitToken('execSignin');
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password, options: { captchaToken } });
  _tsReset('execSignin');
  if (error || !data.user) {
    errEl.textContent = error?.message || 'Sign in failed.';
    errEl.style.display = '';
    btn.textContent = 'Sign In →'; btn.disabled = false;
    return;
  }
  _currentUser = data.user;
  // Check profile role + verified
  const { data: profile } = await supabaseClient.from('profiles').select('role,verified').eq('id', data.user.id).single();
  if (!profile || profile.role !== 'exec') {
    errEl.textContent = 'No industry account found for this email.';
    errEl.style.display = '';
    btn.textContent = 'Sign In →'; btn.disabled = false;
    await supabaseClient.auth.signOut(); _currentUser = null;
    return;
  }
  if (!profile.verified) {
    btn.textContent = '✓ Account found — pending verification';
    btn.style.background = 'rgba(201,168,76,0.85)';
    return;
  }
  // First-time exec login: show exec onboarding. Repeat logins: go straight to dashboard.
  const hasSeenExecOnboard = localStorage.getItem('sceneone_exec_onboard_done');
  if (!hasSeenExecOnboard) {
    goTo('exec-onboard');
  } else {
    goTo('exec-profile');
  }
}

async function handleExecSignup() {
  const name     = document.getElementById('exec-name')?.value.trim();
  const company  = document.getElementById('exec-company')?.value.trim();
  const imdb     = document.getElementById('exec-imdb')?.value.trim();
  const email    = document.getElementById('exec-email')?.value.trim();
  const password = document.getElementById('exec-password')?.value;
  const btn      = document.getElementById('exec-submit-btn');

  if (!name || !company || !email || !password || !_selectedExecRole) {
    btn.textContent = 'Please fill in all required fields';
    btn.style.background = 'rgba(232,146,58,0.8)';
    setTimeout(() => {
      btn.textContent = 'Request Industry Access →';
      btn.style.background = '';
    }, 2500);
    return;
  }

  btn.textContent = 'Creating account…';
  btn.disabled = true;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: name,
        role: 'exec',
        company,
        exec_title: _selectedExecRole,
        imdb_url: imdb || null,
      },
      captchaToken: await (_tsRender('ts-exec-signup', 'execSignup'), _tsAwaitToken('execSignup')),
    }
  });
  _tsReset('execSignup');

  if (error) {
    btn.textContent = error.message;
    btn.style.background = 'rgba(232,146,58,0.8)';
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = 'Request Industry Access →';
      btn.style.background = '';
    }, 3000);
    return;
  }

  // If no session (email confirm enabled), try sign-in
  if (!data.session) {
    const { data: loginData } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (loginData?.session) {
      _currentUser = loginData.user;
      await _createExecProfile({ id: loginData.user.id, name, company, title: _selectedExecRole, imdb });
    }
  } else {
    _currentUser = data.user;
    await _createExecProfile({ id: data.user.id, name, company, title: _selectedExecRole, imdb });
  }

  // Show confirmation state
  btn.textContent = '✓ Request received — we\'ll email you within 24 hours';
  btn.style.background = 'rgba(76,175,125,0.85)';
  btn.disabled = true;
}

async function _createExecProfile({ id, name, company, title, imdb }) {
  try {
    await supabaseClient.from('profiles').upsert({
      id,
      role: 'exec',
      display_name: name,
      company,
      title,
      imdb_url: imdb || null,
      verified: false,
    }, { onConflict: 'id' });
  } catch (e) {
    console.warn('SceneOne: exec profile create failed', e);
  }
}

// Show celebration after first real report
const _origRunProgressBar = runProgressBar;
function runProgressBar(phrases, totalMs, finalPhrase, onComplete) {
  const bar=document.getElementById('proc-bar');
  const ph=document.getElementById('proc-phrase');
  let p=0, pi=0;
  const step=200;
  const increment=98/(totalMs/step);
  const iv=setInterval(()=>{
    p+=increment*(0.7+Math.random()*0.6);
    if(p>98) p=98;
    bar.style.width=p+'%';
    const expectedIdx=Math.floor((p/98)*(phrases.length-1));
    if(expectedIdx>pi&&pi<phrases.length-1){pi=expectedIdx;ph.textContent=phrases[pi];}
  },step);
  setTimeout(()=>{
    clearInterval(iv);
    bar.style.width='100%';
    ph.textContent=finalPhrase;
    if(onComplete) onComplete();
    // Coordinate with API instead of navigating directly
    setTimeout(()=>{ _onLoaderAnimDone(); },1800);
  },totalMs);
}


// ─── TOS SYSTEM ───
let tosAccepted = false;
let firstReport = true;

function showTosModal() {
  document.getElementById('tos-modal').classList.add('show');
}

function checkTosReady() {
  const c1 = document.getElementById('tos-check-1')?.checked;
  const c2 = document.getElementById('tos-check-2')?.checked;
  const btn = document.getElementById('tos-agree-btn');
  if (btn) {
    btn.classList.toggle('ready', c1 && c2);
  }
}



function openTosViewer(tab) {
  document.getElementById('tos-viewer').classList.add('show');
  switchTosTab(tab, document.querySelector(`.tos-viewer-tab:nth-child(${['terms','privacy','content','marketplace'].indexOf(tab)+1})`));
}

function closeTosViewer() {
  document.getElementById('tos-viewer').classList.remove('show');
}

function switchTosTab(tab, el) {
  document.querySelectorAll('.tos-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tos-viewer-tab').forEach(t => t.classList.remove('active'));
  const section = document.getElementById('tos-' + tab);
  if (section) section.classList.add('active');
  if (el) el.classList.add('active');
}

// ─── EXEC MODE UPDATED ───
async function setMode(mode, btn) {
  if (mode === 'exec') {
    // Check if current user has a verified exec profile
    if (!_currentUser) { goTo('exec-signup'); return; }
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('role, verified')
      .eq('id', _currentUser.id)
      .single();
    if (!profile || profile.role !== 'exec' || !profile.verified) {
      // Not a verified exec — send to exec signup
      goTo('exec-signup');
      return;
    }
  }
  document.querySelectorAll('.pill-nav button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('exec-banner');
  if (mode === 'exec') {
    panel.classList.add('show');
  } else {
    panel.classList.remove('show');
  }
}


// ─── EXPORT PDF ───
function exportReport() {
  // Expand all collapsed category bodies so they print
  document.querySelectorAll('.cat-body2').forEach(el => el.classList.add('open'));
  document.querySelectorAll('.cat-head').forEach(el => el.classList.add('open'));

  // Set document title to script name for the PDF filename
  const scriptTitle = document.getElementById('rep-title')?.textContent || 'SceneOne Coverage Report';
  const prevTitle = document.title;
  document.title = scriptTitle;

  window.print();

  // Restore title after print dialog closes
  setTimeout(() => { document.title = prevTitle; }, 1000);
}

// ─── SCRIPT HISTORY ───
async function _saveSubmission(title, data) {
  try {
    const { data: rows } = await supabaseClient.from('submissions').insert({
      title: title || 'Untitled Script',
      user_email: _currentUser?.email || null,
      user_id: _currentUser?.id || null,
      result: data,
      status: 'complete',
      public_listing: false,
    }).select('id');
    if (rows?.[0]?.id) _currentSubId = rows[0].id;
  } catch (e) {
    console.warn('SceneOne: submission save failed', e);
  }
}

async function loadScriptHistory() {
  if (!_currentUser?.email) return;
  const section = document.getElementById('history-section');
  const list = document.getElementById('history-list');
  if (!section || !list) return;

  try {
    const { data, error } = await supabaseClient
      .from('submissions')
      .select('id, created_at, title, result')
      .eq('user_id', _currentUser.id)
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(8);

    if (error || !data?.length) return;

    section.style.display = 'block';
    list.innerHTML = data.map(row => {
      const r = row.result || {};
      const overall = r.overall_score ?? '—';
      const scores = r.scores || {};
      const best = scores ? Object.entries(scores).sort((a,b) => b[1]-a[1])[0] : null;
      const date = new Date(row.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      const scoreColor = overall >= 75 ? 'var(--green)' : overall >= 60 ? 'var(--cyan)' : 'var(--amber)';
      const bestLabel = best ? best[0].charAt(0).toUpperCase() + best[0].slice(1) : '';
      const bestVal = best ? best[1] : '—';

      return `<div class="history-card" data-id="${esc(row.id)}" style="cursor:pointer">
        <div class="history-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="history-info">
          <div class="history-title">${esc(row.title)}</div>
          <div class="history-meta">${date}${bestLabel ? ' &middot; Best: ' + bestLabel : ''}</div>
        </div>
        <div class="history-scores">
          <div class="history-score">
            <div class="history-score-val" style="color:${scoreColor}">${overall}</div>
            <div class="history-score-lbl">Overall</div>
          </div>
          ${bestVal !== '—' ? `<div class="history-score">
            <div class="history-score-val" style="color:var(--cyan)">${bestVal}</div>
            <div class="history-score-lbl">${bestLabel}</div>
          </div>` : ''}
        </div>
        <div class="history-arrow">›</div>
      </div>`;
    }).join('');

    list.addEventListener('click', e => {
      const card = e.target.closest('.history-card');
      if (card) loadHistoryReport(card.dataset.id);
    }, { once: true });

  } catch (e) {
    console.warn('SceneOne: history load failed', e);
  }
}

// Cache of loaded history rows keyed by id
const _historyCache = {};

async function loadHistoryReport(id) {
  // Check cache first, otherwise refetch
  let result = _historyCache[id];
  if (!result) {
    const { data } = await supabaseClient
      .from('submissions')
      .select('title, result')
      .eq('id', id)
      .single();
    if (!data?.result) return;
    result = data.result;
    _historyCache[id] = result;
    // Update report title
    const titleEl = document.getElementById('rep-title');
    if (titleEl && data.title) titleEl.textContent = data.title.toUpperCase() + ' — Draft 1';
    document.getElementById('crawl-title') && (document.getElementById('crawl-title').textContent = data.title.toUpperCase());
  }
  _reportData = result;
  window._lastScores = result.scores || {};
  window._scriptPageCount = null; // will show '—' since we don't have text
  populateReport(result);
  goTo('report');
}

// ─── READER REQUEST ───
function showReaderRequest() {
  document.getElementById('reader-request-modal').classList.add('show');
}

function checkReaderReady() {
  const checked = document.getElementById('reader-check')?.checked;
  const btn = document.getElementById('reader-agree-btn');
  if (btn) btn.classList.toggle('ready', checked);
}

function submitReaderRequest() {
  const checked = document.getElementById('reader-check')?.checked;
  if (!checked) return;
  document.getElementById('reader-request-modal').classList.remove('show');
  // Show confirmation
  const btn = document.querySelector('.exec-request-btn');
  if (btn) {
    btn.textContent = '✓ Request Sent — Writer has 72 hours to respond';
    btn.style.background = 'rgba(76,175,125,0.1)';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'rgba(76,175,125,0.3)';
    btn.disabled = true;
  }
}

// Patch goTo to show TOS modal on first report — safe version
const _origGoToRef = goTo;
window._patchedGoTo = function(id) {
  _origGoToRef(id);
  // TOS handled by checkTosBeforeAnalysis — not here
  document.body.style.setProperty('padding-bottom', 'calc(44px + env(safe-area-inset-bottom,0px))');
};
// ─── AUTH TAB SWITCHING ───
function switchAuthTab(tab) {
  const signupForm = document.getElementById('auth-signup-form');
  const loginForm = document.getElementById('auth-login-form');
  const signupTab = document.getElementById('auth-tab-signup');
  const loginTab = document.getElementById('auth-tab-login');

  if (tab === 'signup') {
    signupForm.style.display = 'block';
    loginForm.style.display = 'none';
    signupTab.style.background = 'var(--card2)';
    signupTab.style.color = '#fff';
    loginTab.style.background = 'transparent';
    loginTab.style.color = 'var(--sub)';
  } else {
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
    loginTab.style.background = 'var(--card2)';
    loginTab.style.color = '#fff';
    signupTab.style.background = 'transparent';
    signupTab.style.color = 'var(--sub)';
  }
}

async function handleLogin() {
  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-password');
  const btn = document.getElementById('login-submit');
  const email = emailEl?.value?.trim() || '';
  const pass = passEl?.value || '';
  if (!email || !pass) return;

  btn.textContent = 'Signing in…';
  btn.disabled = true;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pass, options: { captchaToken: await _tsAwaitToken('writerLogin') } });
  _tsReset('writerLogin');

  if (error) {
    btn.textContent = 'Sign In →';
    btn.disabled = false;
    passEl.style.borderColor = 'rgba(232,146,58,0.6)';
    passEl.parentElement.insertAdjacentHTML('afterend',
      `<div style="color:#E8923A;font-size:12px;margin-top:4px;">${esc(error.message)}</div>`);
    return;
  }

  userName = data.user.user_metadata?.full_name?.split(' ')[0] || email.split('@')[0];
  _currentUser = data.user;
  isFirstTime = false;
  goTo('upload');
  setTimeout(() => {
    const desc = document.querySelector('.upload-desc');
    if (desc && !desc.dataset.greeted) {
      desc.innerHTML = '<span style="color:var(--cyan);font-weight:700">Welcome back. </span>' + desc.innerHTML;
      desc.dataset.greeted = '1';
    }
  }, 100);
}

// Password reset must ALWAYS land on production, no matter where it's triggered
// (local file://, staging, embedded iframe). This site has no env-var build step,
// so the production URL is intentionally hardcoded for this flow.
const RESET_REDIRECT_URL = 'https://sceneone.net/reset-password.html';

async function showForgotPassword(emailId = 'login-email', statusId = 'forgot-status') {
  const emailEl = document.getElementById(emailId);
  const statusEl = document.getElementById(statusId);
  const email = (emailEl?.value || '').trim();

  const setStatus = (color, html) => {
    if (!statusEl) return;
    statusEl.style.color = color;
    statusEl.innerHTML = html;
    statusEl.style.display = 'block';
  };

  if (!email.includes('@') || !email.includes('.')) {
    if (emailEl) { emailEl.style.borderColor = 'rgba(232,146,58,0.6)'; emailEl.focus(); }
    setStatus('var(--amber)', 'Enter the email on your account above, then tap “Forgot your password?”');
    return;
  }

  setStatus('var(--sub)', 'Sending reset link…');

  try {
    if (!supabaseClient) throw new Error('Supabase client unavailable');
    await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: RESET_REDIRECT_URL });
  } catch (e) {
    // Swallow the error on purpose: we show the SAME confirmation whether or not the
    // email is registered (and even on transient failures) so we never leak which
    // addresses have accounts. Real failures are still visible in the console.
    console.warn('SceneOne: password reset request failed —', e?.message);
  }

  const safeEmail = email.replace(/[<>&"]/g, '');
  setStatus('var(--cyan)',
    '✓ Check your email. If an account exists for <strong>' + safeEmail +
    '</strong>, a reset link is on its way. The link expires in 1 hour.');
}

// ─── STRIPE CHECKOUT ───
async function startCheckout(plan) {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      alert('Create an account or sign in first — that way your upgrade is linked to your account automatically.');
      try { goTo('welcome'); } catch (_e) {}
      return;
    }

    const { data, error } = await supabaseClient.functions.invoke('create-checkout', {
      body: { plan },
    });
    if (error || !data?.url) throw new Error(error?.message || 'no checkout url');

    window.location.href = data.url;
  } catch (e) {
    console.warn('SceneOne: create-checkout failed —', e?.message);
    {
      alert('Checkout is temporarily unavailable. Please try again shortly.');
    }
  }
}

// Open the Stripe Customer Portal so the user can cancel / change plan / update
// their card. Cancelling there triggers customer.subscription.deleted, which the
// stripe-webhook function catches and downgrades the account to free.
async function manageSubscription(btn) {
  const label = btn?.textContent;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { alert('Please sign in to manage your plan.'); return; }
    if (btn) { btn.textContent = 'Opening…'; btn.disabled = true; }

    const { data, error } = await supabaseClient.functions.invoke('create-portal', { body: {} });
    if (error || !data?.url) {
      // 404 from the function = no Stripe customer yet (never subscribed).
      throw new Error(data?.error || error?.message || 'no portal url');
    }
    window.location.href = data.url;
  } catch (e) {
    console.warn('SceneOne: manageSubscription failed —', e?.message);
    alert("We couldn't open the billing portal — you may not have an active subscription yet. To upgrade, see the Plans screen.");
  } finally {
    if (btn) { btn.textContent = label; btn.disabled = false; }
  }
}

// On return from Stripe, give the user honest feedback (the webhook applies the
// upgrade server-side, which can take a few seconds).
(function checkoutReturn() {
  const status = new URLSearchParams(location.search).get('checkout');
  if (status === 'success') {
    setTimeout(() => alert('🎉 Payment received — thank you! Your plan activates within a few seconds. If it doesn’t show yet, refresh the page.'), 400);
  } else if (status === 'cancelled') {
    setTimeout(() => alert('Checkout cancelled — no charge was made. You can upgrade any time from the Plans screen.'), 400);
  }
})();

// Apply patch after a tick so original goTo is defined
// Apply patch after a tick so original goTo is defined
setTimeout(()=>{ if(typeof goTo === 'function') window.goTo = window._patchedGoTo; }, 0);


// ─── TOS BEFORE ANALYSIS ───
function checkTosBeforeAnalysis() {
  if (!tosAccepted) {
    // Show TOS modal, then on accept → start processing
    showTosModal();
    // Override acceptTos to also start processing
    window._tosCallback = () => startProcessing();
  } else {
    startProcessing();
  }
}

// Patch acceptTos to handle callback
const _origAcceptTos = acceptTos;
function acceptTos() {
  const c1 = document.getElementById('tos-check-1')?.checked;
  const c2 = document.getElementById('tos-check-2')?.checked;
  if (!c1 || !c2) return;
  tosAccepted = true;
  document.getElementById('tos-modal').classList.remove('show');
  const cp = document.getElementById('contact-pref');
  if (cp) cp.style.display = 'block';
  // Fire callback if set (e.g. start processing after TOS accept)
  if (window._tosCallback) {
    const cb = window._tosCallback;
    window._tosCallback = null;
    setTimeout(cb, 300);
  }
}

// ─── FILM BURN SCORE ANIMATION ───
function _getScoreDeltas() {
  const s = window._lastScores || {};
  return {
    'ed-structure': { cat: 'cat-structure', old: s.structure || 75, bump: 5 },
    'ed-conflict':  { cat: 'cat-conflict',  old: s.conflict  || 70, bump: 8 },
    'ed-pacing':    { cat: 'cat-pacing',    old: s.pacing    || 65, bump: 7 },
  };
}
function _getCcScoreMap() {
  const s = window._lastScores || {};
  return {
    'cc-structure': { catId: 'cat-structure', oldScore: s.structure || 75, newScore: (s.structure || 75) + 5 },
    'cc-conflict':  { catId: 'cat-conflict',  oldScore: s.conflict  || 70, newScore: (s.conflict  || 70) + 8 },
    'cc-pacing':    { catId: 'cat-pacing',    oldScore: s.pacing    || 65, newScore: (s.pacing    || 65) + 7 },
    'cc-visual':    { catId: 'cat-visual',    oldScore: s.visual    || 78, newScore: (s.visual    || 78) + 4 },
  };
}
const scoreDeltas = new Proxy({}, { get: (_, k) => _getScoreDeltas()[k] });
const ccScoreMap   = new Proxy({}, { get: (_, k) => _getCcScoreMap()[k]  });

function markCreativeChoice(ccId) {
  const btn = document.getElementById(ccId);
  const logged = document.getElementById(ccId + '-logged');
  if (!btn) return;

  if (btn.classList.contains('chosen')) {
    btn.classList.remove('chosen');
    btn.innerHTML = '✦ Creative Choice';
    if (logged) logged.classList.remove('show');
    return;
  }

  btn.classList.add('chosen');
  btn.innerHTML = '✓ Creative Choice — Logged';
  if (logged) logged.classList.add('show');

  // Close inline editor
  const edId = ccId.replace('cc-', 'ed-');
  const ed = document.getElementById(edId);
  if (ed) ed.classList.remove('open');

  // Fire score burn animation
  const scoreData = ccScoreMap[ccId];
  if (scoreData) {
    setTimeout(() => burnScore(scoreData.catId, scoreData.oldScore, scoreData.newScore), 400);
  }
}

function burnScore(catId, oldScore, newScore) {
  const card = document.getElementById(catId);
  if (!card) return;

  const oldEl = card.querySelector('.score-burn-old');
  const newEl = card.querySelector('.score-burn-new');
  const bumpEl = card.querySelector('.score-bump-flash');

  if (!oldEl || !newEl) return;

  // Spawn ash particles
  spawnAsh(oldEl);

  // Start burn
  oldEl.classList.add('burning');

  // Set new score text
  newEl.textContent = newScore;

  // Rise after burn
  setTimeout(() => {
    newEl.classList.add('rising');
  }, 500);

  // Show bump flash
  if (bumpEl) {
    const delta = newScore - oldScore;
    bumpEl.textContent = '+' + delta;
    setTimeout(() => bumpEl.classList.add('show'), 600);
  }

  // Update sidebar score
  setTimeout(() => updateSidebarScore(catId, newScore), 900);
  
  // Update overall score
  setTimeout(() => updateOverallScore(), 1000);
}

function spawnAsh(el) {
  const rect = el.getBoundingClientRect();
  const parent = el.closest('.score-burn-wrap') || el.parentElement;
  for (let i = 0; i < 8; i++) {
    const ash = document.createElement('div');
    ash.className = 'ash-particle';
    const angle = (Math.random() * 180) - 90;
    const dist = 20 + Math.random() * 30;
    ash.style.cssText = `
      --ash-x: ${Math.cos(angle * Math.PI/180) * dist}px;
      --ash-y: ${-Math.abs(Math.sin(angle * Math.PI/180) * dist) - 10}px;
      --ash-dur: ${0.4 + Math.random() * 0.4}s;
      --ash-delay: ${Math.random() * 0.2}s;
      left: ${Math.random() * 100}%;
      top: 50%;
    `;
    parent.appendChild(ash);
    setTimeout(() => ash.remove(), 800);
  }
}

function updateSidebarScore(catId, newScore) {
  const map = {
    'cat-structure': 0,
    'cat-conflict': 1,
    'cat-dialogue': 2,
    'cat-pacing': 3,
    'cat-visual': 4
  };
  const idx = map[catId];
  if (idx === undefined) return;
  const scats = document.querySelectorAll('.scat-score');
  const srNums = document.querySelectorAll('.sr-num');
  if (scats[idx]) scats[idx].textContent = newScore;
  if (srNums[idx]) srNums[idx].textContent = newScore;
}

function updateOverallScore() {
  const overallEl = document.querySelector('.sidebar-score-big');
  if (!overallEl) return;
  // Read live scores from DOM (set by populateReport / applyCreativeChoice)
  const scoreEls = document.querySelectorAll('.scat-score');
  const vals = Array.from(scoreEls).map(el => parseInt(el.textContent, 10)).filter(n => !isNaN(n));
  if (!vals.length) return;
  const avg = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
  overallEl.style.transition = 'all .3s';
  overallEl.style.filter = 'brightness(1.5)';
  setTimeout(() => {
    overallEl.textContent = avg;
    overallEl.style.filter = 'none';
  }, 300);
}

// ─── PHASE 3 TAG ───
// Add phase 3 note to revision plan
document.addEventListener('DOMContentLoaded', () => {
  const revCard = document.querySelector('.rev-card');
  if (revCard) {
    const phase3 = document.createElement('div');
    phase3.style.cssText = 'margin-top:14px;padding:10px 12px;background:rgba(62,237,231,0.04);border:1px dashed rgba(62,237,231,0.2);border-radius:8px;font-size:10px;color:var(--sub);line-height:1.6;';
    phase3.innerHTML = '<span style="color:var(--cyan);font-weight:700;">Phase 3 (Coming Soon)</span> — Write your script directly inside SceneOne. Draft, analyze, and revise without ever leaving the app. Think Celtx — but built around feedback from the start.';
    revCard.appendChild(phase3);
  }
});


// ─── PASSWORD STRENGTH ───
function checkPasswordStrength(pw) {
  const fill = document.getElementById('pw-fill');
  const label = document.getElementById('pw-label');
  const reqLen = document.getElementById('req-len');
  const reqUpper = document.getElementById('req-upper');
  const reqNum = document.getElementById('req-num');
  const reqSpecial = document.getElementById('req-special');
  if (!fill) return;

  const hasLen = pw.length >= 8;
  const hasUpper = /[A-Z]/.test(pw);
  const hasNum = /[0-9]/.test(pw);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw);

  // Update requirement indicators
  reqLen?.classList.toggle('met', hasLen);
  reqUpper?.classList.toggle('met', hasUpper);
  reqNum?.classList.toggle('met', hasNum);
  reqSpecial?.classList.toggle('met', hasSpecial);

  const score = [hasLen, hasUpper, hasNum, hasSpecial].filter(Boolean).length;

  if (pw.length === 0) {
    fill.style.width = '0%';
    fill.style.background = 'var(--border)';
    label.textContent = 'Enter a password';
    label.style.color = 'var(--sub)';
  } else if (score === 1) {
    fill.style.width = '25%';
    fill.style.background = '#E85030';
    label.textContent = 'Weak';
    label.style.color = '#E85030';
  } else if (score === 2) {
    fill.style.width = '50%';
    fill.style.background = 'var(--amber)';
    label.textContent = 'Fair';
    label.style.color = 'var(--amber)';
  } else if (score === 3) {
    fill.style.width = '75%';
    fill.style.background = 'var(--gold)';
    label.textContent = 'Good';
    label.style.color = 'var(--gold)';
  } else if (score === 4) {
    fill.style.width = '100%';
    fill.style.background = 'var(--green)';
    label.textContent = 'Strong ✓';
    label.style.color = 'var(--green)';
  }
}

// ─── FORM VALIDATION ───
function checkSignupReady() {
  const name = document.getElementById('ob-name')?.value?.trim();
  const email = document.getElementById('ob-email')?.value?.trim();
  const pw = document.getElementById('ob-password')?.value || '';
  const btn = document.getElementById('signup-submit');
  if (!btn) return;

  const hasLen = pw.length >= 8;
  const hasUpper = /[A-Z]/.test(pw);
  const hasNum = /[0-9]/.test(pw);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw);
  const pwStrong = hasLen && hasUpper && hasNum && hasSpecial;
  const emailValid = email.includes('@') && email.includes('.');

  const ready = name?.length > 0 && emailValid && pwStrong;
  btn.classList.toggle('ready', ready);

  // Visual feedback on fields
  const emailEl = document.getElementById('ob-email');
  if (emailEl && email.length > 0) {
    emailEl.classList.toggle('valid', emailValid);
    emailEl.classList.toggle('invalid', !emailValid);
  }
}

function checkLoginReady() {
  const email = document.getElementById('login-email')?.value?.trim();
  const pw = document.getElementById('login-password')?.value;
  const btn = document.getElementById('login-submit');
  if (!btn) return;
  const ready = email?.includes('@') && pw?.length >= 6;
  btn.classList.toggle('ready', ready);
}

// ─── HEATMAP LEGEND LABEL ───
// Add a visible "What this means" label above the heatmap
document.addEventListener('DOMContentLoaded', () => {
  const heatmapCard = document.querySelector('.heatmap-card');
  if (heatmapCard) {
    const legendNote = document.createElement('div');
    legendNote.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;';
    legendNote.innerHTML = `
      <div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--sub);">
        <div style="width:10px;height:10px;border-radius:2px;background:rgba(232,100,30,0.8);"></div>
        <span style="color:var(--amber)">Slow — momentum stalls</span>
      </div>
      <div style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--sub);">
        <div style="width:10px;height:10px;border-radius:2px;background:rgba(62,237,231,0.6);"></div>
        <span style="color:var(--cyan)">Strong — keep going</span>
      </div>
      <div style="font-size:10px;color:var(--sub);">Hover any cell to see what's happening on that page.</div>
    `;
    const cardHeader = heatmapCard.querySelector('.card-header');
    if (cardHeader) cardHeader.after(legendNote);
  }
});


// ─── LISTING TOGGLE ───
async function _ensureSubId() {
  if (_currentSubId) return _currentSubId;
  if (!_currentUser?.id) return null;
  const { data } = await supabaseClient.from('submissions')
    .select('id').eq('user_id', _currentUser.id).eq('status', 'complete')
    .order('created_at', { ascending: false }).limit(1);
  if (data?.[0]?.id) _currentSubId = data[0].id;
  return _currentSubId;
}

function toggleListing(checkbox) {
  const label = document.getElementById('listing-status-label');
  const privateNotice = document.getElementById('listing-private');
  const liveSection = document.getElementById('listing-live');

  if (checkbox.checked) {
    checkbox.checked = false;
    document.getElementById('mkt-tos-writer').classList.add('show');
  } else {
    label.textContent = 'Private';
    privateNotice.style.display = 'block';
    liveSection.style.display = 'none';
    _ensureSubId().then(id => {
      if (id) supabaseClient.from('submissions').update({ public_listing: false }).eq('id', id).then(({error}) => {
        if (error) console.warn('SceneOne: toggle-off failed', error);
      });
    });
  }
}

function checkWriterMktReady() {
  const checked = document.getElementById('writer-mkt-check')?.checked;
  const btn = document.getElementById('writer-mkt-btn');
  if (btn) btn.classList.toggle('ready', checked);
}

async function confirmWriterListing() {
  const checked = document.getElementById('writer-mkt-check')?.checked;
  if (!checked) return;
  document.getElementById('mkt-tos-writer').classList.remove('show');

  const toggle = document.getElementById('listing-toggle-input');
  const label = document.getElementById('listing-status-label');
  const privateNotice = document.getElementById('listing-private');
  const liveSection = document.getElementById('listing-live');

  // Write to Supabase FIRST — only update UI on success
  const id = await _ensureSubId();
  console.log('SceneOne: confirmWriterListing sub id =', id);

  if (!id) {
    console.warn('SceneOne: no submission found to make public');
    _showListingToast('No submission found — reload the page and try again.', true);
    return;
  }

  const { error } = await supabaseClient.from('submissions').update({ public_listing: true }).eq('id', id);
  if (error) {
    console.error('SceneOne: listing update failed', error);
    _showListingToast('Update failed: ' + error.message, true);
    return;
  }

  // Success — update UI
  if (toggle) toggle.checked = true;
  if (label) label.textContent = 'Live';
  if (privateNotice) privateNotice.style.display = 'none';
  if (liveSection) liveSection.style.display = 'block';
  loadListingStats(id);
  loadRequestCards(id);
  showGoodLuck();
}

function _showListingToast(msg, isError) {
  const existing = document.getElementById('listing-status-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'listing-status-toast';
  const color = isError ? 'rgba(255,80,80,0.4)' : 'rgba(62,237,231,0.3)';
  const textColor = isError ? 'rgba(255,120,120,0.95)' : 'var(--cyan)';
  toast.style.cssText = `position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#1A1A1A;border:1px solid ${color};border-radius:10px;padding:12px 20px;font-size:12px;font-weight:700;color:${textColor};z-index:9999;white-space:nowrap;box-shadow:0 8px 32px rgba(0,0,0,0.5);`;
  toast.textContent = (isError ? '⚠ ' : '✓ ') + msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function showGoodLuck() {
  const overlay = document.getElementById('cinematic-goodluck');
  overlay.classList.add('show');
  setTimeout(() => {
    overlay.style.transition = 'opacity .8s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.style.opacity = '';
      overlay.style.transition = '';
    }, 800);
  }, 3200);
}

// ─── REQUESTS INBOX (writer — all scripts) ───
async function loadRequestsScreen() {
  const inbox = document.getElementById('requests-inbox');
  const heading = document.getElementById('req-heading');
  if (!inbox || !_currentUser) return;
  inbox.innerHTML = '<div style="padding:40px;text-align:center;color:var(--sub);font-size:13px;">Loading…</div>';

  try {
    const { data, error } = await supabaseClient
      .from('read_requests')
      .select('id, exec_name, exec_email, status, created_at, expires_at, submission_id, submissions(title)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const pending = (data || []).filter(r => r.status === 'pending');
    if (heading) heading.textContent = pending.length ? `${pending.length} Pending Request${pending.length === 1 ? '' : 's'}` : 'Reader Requests';

    if (!data?.length) {
      inbox.innerHTML = `<div style="padding:60px 24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:16px;">&#10003;</div>
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:8px;">You're all caught up.</div>
        <div style="font-size:13px;color:var(--sub);line-height:1.7;">No requests yet. When industry readers find your listing and request access, they'll appear here.</div>
      </div>`;
      return;
    }

    inbox.innerHTML = data.map(r => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const initials = (r.exec_name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const scriptTitle = r.submissions?.title || '—';
      const expired = r.status === 'approved' && r.expires_at && new Date(r.expires_at).getTime() < Date.now();
      const statusColor = expired ? 'var(--sub)' : r.status === 'approved' ? 'var(--green)' : r.status === 'declined' ? 'var(--sub)' : 'var(--cyan)';
      const statusLabel = expired ? 'Expired'
        : r.status === 'approved' && r.expires_at
          ? `Approved · Access until ${new Date(r.expires_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`
          : r.status.charAt(0).toUpperCase() + r.status.slice(1);
      const actions = r.status === 'pending'
        ? `<div style="display:flex;gap:8px;margin-top:14px;">
             <button data-req-id="${esc(r.id)}" data-req-action="approved" class="req-inbox-action req-approve" style="flex:1;padding:10px;border-radius:8px;border:none;background:rgba(76,175,125,0.15);color:var(--green);font-size:12px;font-weight:700;cursor:pointer;">Approve — 14-Day Access</button>
             <button data-req-id="${esc(r.id)}" data-req-action="declined" class="req-inbox-action req-decline" style="padding:10px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--sub);font-size:12px;font-weight:700;cursor:pointer;">Decline</button>
           </div>`
        : `<div style="margin-top:10px;font-size:11px;font-weight:700;color:${statusColor}">${statusLabel}</div>`;
      return `<div class="req-card" style="margin-bottom:12px;">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div class="req-avatar" style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#053154,#0a4a7a);color:var(--cyan);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${esc(initials)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;color:#fff;">${esc(r.exec_name)}</div>
            <div style="font-size:11px;color:var(--sub);margin-top:2px;">${esc(r.exec_email)}</div>
            <div style="font-size:11px;color:var(--sub);margin-top:4px;">Re: <span style="color:var(--cyan);">${esc(scriptTitle)}</span> · ${date}</div>
            ${actions}
          </div>
        </div>
      </div>`;
    }).join('');

    inbox.addEventListener('click', async e => {
      const btn = e.target.closest('.req-inbox-action');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = btn.dataset.reqAction === 'approved' ? 'Approving…' : 'Declining…';
      await handleRequestAction(btn.dataset.reqId, btn.dataset.reqAction);
      loadRequestsScreen();
    });

  } catch(e) {
    console.warn('SceneOne: loadRequestsScreen failed', e);
    inbox.innerHTML = '<div style="padding:40px;text-align:center;color:var(--sub);font-size:13px;">Could not load requests. Try refreshing.</div>';
  }
}

// ─── REALTIME — exec discovery dashboard ───
let _realtimeSub = null;

function _startDashRealtime() {
  if (_realtimeSub) return;
  _realtimeSub = supabaseClient
    .channel('discovery-listings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, () => loadDashboard())
    .subscribe();
}

function _stopDashRealtime() {
  if (_realtimeSub) { supabaseClient.removeChannel(_realtimeSub); _realtimeSub = null; }
}

// ─── READER MARKETPLACE ───
function openReaderMarketplace() {
  document.getElementById('mkt-tos-reader').classList.add('show');
}

function checkReaderMktReady() {
  const checked = document.getElementById('reader-mkt-check')?.checked;
  const btn = document.getElementById('reader-mkt-btn');
  if (btn) btn.classList.toggle('ready', checked);
}

function confirmReaderAccess() {
  const checked = document.getElementById('reader-mkt-check')?.checked;
  if (!checked) return;
  document.getElementById('mkt-tos-reader').classList.remove('show');

  // Happy Hunting cinematic
  showHappyHunting();
}

function showHappyHunting() {
  const overlay = document.getElementById('cinematic-hunting');
  overlay.classList.add('show');
  setTimeout(() => {
    overlay.style.transition = 'opacity .6s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.style.opacity = '';
      overlay.style.transition = '';
      goTo('dashboard');
    }, 600);
  }, 2800);
}



// ─── TITLE + CO-WRITERS ───
let cowriterCount = 0;

function removeFile() {
  _uploadedFile = null;
  document.getElementById('file-row').classList.remove('show');
  document.getElementById('analyze-btn').classList.remove('ready');
  const err = document.getElementById('upload-error-msg');
  if (err) err.style.display = 'none';
  document.getElementById('file-input').value = '';
  const meta = document.getElementById('script-meta-section');
  if (meta) meta.style.display = 'none';
  const dz = document.querySelector('.drop-zone');
  if (dz) dz.classList.remove('success', 'error');
}

function showUploadError(msg) {
  // Go back to upload screen and show error
  goTo('upload');
  const zone = document.querySelector('.drop-zone');
  let err = document.getElementById('upload-error-msg');
  if (!err) {
    err = document.createElement('div');
    err.id = 'upload-error-msg';
    err.style.cssText = 'margin-top:14px;padding:12px 16px;background:rgba(232,146,58,0.1);border:1px solid rgba(232,146,58,0.35);border-radius:10px;color:#E8923A;font-size:13px;line-height:1.5;';
    zone.after(err);
  }
  err.textContent = msg;
  err.style.display = 'block';
}

function handleFile(i) {
  const f = i.files[0];
  if (!f) return;
  const err = document.getElementById('upload-error-msg');
  if (err) err.style.display = 'none';
  if (!f.name.toLowerCase().endsWith('.pdf')) {
    showUploadError('SceneOne only accepts PDF files. Export your script as a PDF from Word, Final Draft, or Google Docs first.');
    i.value = '';
    return;
  }
  _uploadedFile = f;
  setFile(f);
}

function setFile(f) {
  _uploadedFile = f;
  window._isSampleRun = false; // real upload — subject to the plan limit
  // Drop-zone success flash
  const dz = document.querySelector('.drop-zone');
  if (dz) {
    dz.classList.remove('error');
    dz.classList.add('success');
    setTimeout(() => dz.classList.remove('success'), 1200);
  }
  document.getElementById('file-row').classList.add('show');
  document.getElementById('file-nm').textContent = f.name;
  const kb = f.size / 1024;
  document.getElementById('file-sz').textContent = kb < 1024 ? Math.round(kb) + ' KB' : (kb/1024).toFixed(1) + ' MB';

  // Show script meta section
  const meta = document.getElementById('script-meta-section');
  if (meta) meta.style.display = 'block';

  // Try to parse title from filename
  const raw = f.name.replace(/\.(pdf|fdx|fountain|txt)$/i,'');
  const cleaned = raw.replace(/[-_]/g,' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

  // Show detected title
  const titleInput = document.getElementById('script-title-input');
  const parsedNote = document.getElementById('title-parsed-note');
  const detectedDisplay = document.getElementById('detected-title-display');
  const titleConfirmInput = document.getElementById('title-confirm-input');

  if (titleInput) titleInput.value = cleaned.toUpperCase();
  if (detectedDisplay) detectedDisplay.textContent = cleaned.toUpperCase();
  if (titleConfirmInput) titleConfirmInput.value = cleaned.toUpperCase();
  if (parsedNote) parsedNote.style.display = 'flex';

  // Show title confirm modal after brief delay
  setTimeout(() => {
    document.getElementById('title-confirm-overlay').classList.add('show');
  }, 600);

  // Update crawl and report title
  const crawlEl = document.getElementById('crawl-title');
  if (crawlEl) crawlEl.textContent = cleaned.toUpperCase();
  const repTitleEl = document.getElementById('rep-title');
  if (repTitleEl) repTitleEl.textContent = cleaned.toUpperCase() + ' — Draft 1';

  document.getElementById('analyze-btn').classList.add('ready');
  checkAnalyzeReady();

  // Duplicate guard: read file, hash it, warn if matches previous upload
  if (_currentUser?.id) {
    const reader = new FileReader();
    reader.onload = async e => {
      const text = e.target?.result || '';
      const hash = await _hashText(text);
      if (!hash) return;
      const prevHash = localStorage.getItem('so_script_hash_' + _currentUser.id);
      const prevSubId = localStorage.getItem('so_script_sub_' + _currentUser.id);
      if (hash === prevHash && prevSubId) {
        // Show non-blocking yellow warning
        let warn = document.getElementById('dup-upload-warn');
        if (!warn) {
          warn = document.createElement('div');
          warn.id = 'dup-upload-warn';
          warn.style.cssText = 'margin-top:10px;padding:10px 14px;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.35);border-radius:8px;font-size:12px;color:#DDB85A;display:flex;align-items:center;justify-content:space-between;gap:10px;';
          warn.innerHTML = `<span>⚠ This looks like a script you've already analyzed. <button onclick="loadHistoryReport('${prevSubId}');document.getElementById('dup-upload-warn')?.remove()" style="background:none;border:none;color:var(--gold);font-weight:700;font-size:12px;cursor:pointer;text-decoration:underline;">Load previous report →</button></span><button onclick="this.closest('#dup-upload-warn').remove()" style="background:none;border:none;color:var(--sub);cursor:pointer;font-size:16px;line-height:1;">×</button>`;
          const analyzeBtn = document.getElementById('analyze-btn');
          if (analyzeBtn) analyzeBtn.after(warn);
        }
      }
    };
    reader.readAsText(f);
  }
}

function confirmTitle() {
  const input = document.getElementById('title-confirm-input');
  const titleInput = document.getElementById('script-title-input');
  const val = (input?.value || '').trim().toUpperCase() || 'UNTITLED SCRIPT';

  if (titleInput) titleInput.value = val;
  const crawlEl = document.getElementById('crawl-title');
  if (crawlEl) crawlEl.textContent = val;
  const repEl = document.getElementById('rep-title');
  if (repEl) repEl.textContent = val + ' — Draft 1';
  document.getElementById('title-confirm-overlay').classList.remove('show');
  checkAnalyzeReady();
}

function checkAnalyzeReady() {
  const title = document.getElementById('script-title-input')?.value?.trim();
  const fileReady = document.getElementById('file-row')?.classList.contains('show');
  const btn = document.getElementById('analyze-btn');
  if (btn) btn.classList.toggle('ready', !!(title && fileReady));
}


function addCowriter() {
  const list = document.getElementById('cowriter-list');
  const addBtn = document.getElementById('add-cowriter-btn');
  if (!list) return;

  cowriterCount++;
  if (cowriterCount >= 3) addBtn.style.display = 'none';

  const row = document.createElement('div');
  row.className = 'cowriter-row';
  row.id = 'cowriter-row-' + cowriterCount;
  row.innerHTML = `
    <input class="cowriter-name" type="text" placeholder="Full name" id="cw-name-${cowriterCount}">
    <input class="cowriter-email" type="email" placeholder="Email for notifications" id="cw-email-${cowriterCount}">
    <button class="cowriter-remove" onclick="removeCowriter(${cowriterCount})">×</button>
  `;
  list.appendChild(row);
}

function removeCowriter(id) {
  const row = document.getElementById('cowriter-row-' + id);
  if (row) row.remove();
  cowriterCount = Math.max(0, cowriterCount - 1);
  const addBtn = document.getElementById('add-cowriter-btn');
  if (addBtn && cowriterCount < 3) addBtn.style.display = 'flex';
}

// ─── SAMPLE SCREENPLAY TEXT — fed to real API so demo mode runs live analysis ───
const SAMPLE_SCRIPT_TEXT = `THE LAST HOUR
Written by Mara Voss

FADE IN:

EXT. DOWNTOWN PARKING STRUCTURE - NIGHT

Rain hammers concrete. A white sedan idles on the fourth floor, engine running, lights off.

INT. WHITE SEDAN - CONTINUOUS

DETECTIVE CLAIRE NOVAK (38, sharp eyes, three days of bad sleep) stares at her phone. A text: "You have 60 minutes. Tick tock."

She grips the steering wheel. Breathes. Then pulls her badge, checks the clip in her Glock, and gets out.

EXT. PARKING STRUCTURE - CONTINUOUS

Claire moves fast — heels clicking, each step deliberate. She knows this building. She arrested someone here seven years ago. She got it wrong.

INT. STAIRWELL - CONTINUOUS

She takes the stairs two at a time, hand on the rail, scanning. Halfway up, she stops.

A BURNER PHONE sits on the third step. Taped to it: a photograph.

Claire picks up the photo. Her daughter. Maya, 9, in her school uniform, outside Jefferson Elementary — taken TODAY.

CLAIRE
(barely a whisper)
Oh God.

The burner phone BUZZES. She answers.

VOICE (V.O.)
(distorted)
Fifty-eight minutes, Detective. My client wants the file on the Delgado case. The one you buried.

CLAIRE
I don't know what you're talking about.

VOICE (V.O.)
Then Maya's going to have a very bad night.

The line goes dead. Claire stands frozen for exactly one second — then she's moving again, faster now, taking the stairs three at a time.

EXT. PARKING STRUCTURE - ROOFTOP - NIGHT

She bursts onto the roof. Wind. Rain. And a clear view of the city — the courthouse, the precinct, and three blocks north, Jefferson Elementary.

Claire dials. Ringing. Ringing.

SCHOOL ADMINISTRATOR (V.O.)
Jefferson after-hours, this is—

CLAIRE
This is Detective Novak. My daughter Maya is in after-school care. I need you to lock down the building. Right now. Do not let anyone in or out.

SCHOOL ADMINISTRATOR (V.O.)
I'm sorry, what? Is this—

CLAIRE
Do it. I'll explain in twenty minutes.

She hangs up. Stares at the city. Somewhere out there, someone has eyes on her daughter. Someone who knows about Delgado.

Someone who knows what she did.

CLAIRE (CONT'D)
(to herself)
Fifty-seven minutes.

She turns and walks back toward the stairwell — jaw set, something decided behind her eyes. She's not running anymore. She's hunting.

SMASH CUT TO:

INT. POLICE PRECINCT - EVIDENCE ROOM - NIGHT

A FILE FOLDER sits in a metal cage, labeled: DELGADO, R. — CASE #7741 — CLOSED.

Claire's hand reaches through the bars. Takes it.

INT. PRECINCT - HALLWAY - CONTINUOUS

She walks past her CAPTAIN'S office, head down. The Captain is on the phone, back turned. She doesn't stop.

EXT. PRECINCT - PARKING LOT - NIGHT

Claire gets in her car. Opens the folder. Photographs. Reports. And one thing that was never supposed to be in there: a handwritten note in her own writing.

She reads it. Her expression doesn't change.

She starts the car.

CLAIRE
(quiet, to no one)
Fifty-three minutes.

SMASH CUT TO TITLES: THE LAST HOUR

FADE OUT.

ACT TWO

INT. CITY HALL - RECORDS OFFICE - NIGHT

Claire moves through empty corridors with the borrowed keycard of a clerk she owes a favor. The offices are dark. She finds the terminal she needs.

Types. Waits. The screen fills with property records — shell companies, a warehouse on the east side, a name that keeps appearing: MERIDIAN HOLDINGS.

Behind that name: COUNCILMAN VICTOR RESH (55, photographs show a man who smiles for cameras and means none of it).

CLAIRE (V.O.)
Delgado wasn't a drug dealer. He was a witness. And I was told to close the case before he could testify.

She copies the files to a drive. The burner phone buzzes again.

VOICE (V.O.)
Wrong direction, Detective. My client doesn't want Meridian. He wants what Delgado gave you. The original recording.

CLAIRE
There is no recording.

VOICE (V.O.)
Forty-one minutes.

Claire closes her eyes. Opens them.

CLAIRE
(measured)
If anything happens to my daughter, I will burn everything. Every file. Every name. I'll go public with all of it.

VOICE (V.O.)
(a beat, then)
You wouldn't. You'd go to prison.

CLAIRE
I'm already in prison.

She disconnects. Sits in the dark office. Then, slowly, she opens her own phone and scrolls to a contact: DELGADO, R. — PERSONAL.

She dials.

It rings.

And rings.

And then — impossibly — someone picks up.

DELGADO (V.O.)
(quiet, wary)
I wondered when you'd call.

CLAIRE
(stunned)
You're alive.

DELGADO (V.O.)
Barely. And not for long, if the wrong people find out I called you back.

CLAIRE
I need the recording.

DELGADO (V.O.)
The recording doesn't exist anymore. But I do. And I remember everything.

CLAIRE
Then I need you. Right now.

A long silence on the line.

DELGADO (V.O.)
There's a warehouse. East side, Meridian Holdings. Dock 7. Come alone.

CLAIRE
I have thirty-nine minutes.

DELGADO (V.O.)
That's enough time. If you drive fast.

The line goes dead. Claire looks at the property records on the screen — the warehouse address is already highlighted.

She drives fast.`;

function useSample() {
  const title = 'THE LAST HOUR';
  const crawlTitleEl = document.getElementById('crawl-title');
  if (crawlTitleEl) crawlTitleEl.textContent = title;
  const repSampleEl = document.getElementById('rep-title');
  if (repSampleEl) repSampleEl.textContent = title + ' — Sample Draft';
  document.getElementById('file-row').classList.add('show');
  document.getElementById('file-nm').textContent = 'the-last-hour-draft1.pdf';
  document.getElementById('file-sz').textContent = 'Sample script · 94 pages';

  const meta = document.getElementById('script-meta-section');
  if (meta) {
    meta.style.display = 'block';
    const titleInput = document.getElementById('script-title-input');
    if (titleInput) titleInput.value = title;
  }

  // Create a real File blob so _runAnalysis() calls the live API
  _uploadedFile = new File([SAMPLE_SCRIPT_TEXT], 'the-last-hour-draft1.txt', { type: 'text/plain' });
  window._isSampleRun = true; // demo script — exempt from the plan limit server-side

  document.getElementById('analyze-btn').classList.add('ready');
  setTimeout(() => checkTosBeforeAnalysis(), 600);
}

// ─── CLAPPER FIX — force equal random distribution ───
let _lastLoader = -1;
let _uploadedFile = null;
let _scriptType = 'feature';

function setScriptType(type) {
  _scriptType = type;
  document.getElementById('stt-feature').classList.toggle('active', type === 'feature');
  document.getElementById('stt-short').classList.toggle('active', type === 'short');
  document.getElementById('stt-hint').textContent = type === 'short'
    ? 'Short film (~5–40 pages) — graded on compressed structure'
    : 'Feature length (~80–120 pages)';
}
let _currentUser = null;
let _currentSubId = null;
let _dashSort = 'score';
function getNextLoader() {
  // 1=Countdown, 2=Clapper, 3=Typewriter, 4=Spotlight
  let next;
  do { next = 1 + Math.floor(Math.random() * 4); } while (next === _lastLoader);
  _lastLoader = next;
  return next;
}

function startProcessing() {
  if (!_uploadedFile) {
    showUploadError('Please select a script file before analyzing.');
    return;
  }

  // Reset coordination flags
  _loaderDone = false;
  _apiDone    = false;
  _reportData = null;

  // Button loading state
  const btn = document.getElementById('analyze-btn');
  if (btn) { btn.classList.remove('ready'); btn.classList.add('loading'); btn.textContent = 'Reading script…'; }

  goTo('processing');
  const which = getNextLoader();
  if (which === 1) runCountdown();
  else if (which === 2) runClapper();
  else if (which === 3) runTypewriter();
  else runSpotlight();

  // Kick off real API call (non-blocking — runs in parallel with loader)
  _runAnalysis();
}

async function _hashText(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch(_e) { return null; }
}

async function _runAnalysis() {
  try {
    if (!SUPABASE_URL || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
      goTo('upload');
      showUploadError('SceneOne is not configured yet. Contact support.');
      return;
    }

    const titleInput = document.getElementById('script-title-input');
    const file = _uploadedFile;
    const title = titleInput?.value?.trim() || 'Untitled Script';

    if (!file) {
      goTo('upload');
      showUploadError('Please select a script file before analyzing.');
      return;
    }

    // Extract text from the uploaded file
    const scriptText = await extractScriptText(file);

    if (!scriptText || scriptText.trim().length < 200) {
      showUploadError('We couldn\'t read your file. Make sure it\'s a PDF — Word docs and Final Draft files need to be exported as PDF first.');
      return;
    }

    // Duplicate upload guard — check if this exact script was already analyzed
    if (!window._isSampleRun && _currentUser?.id) {
      const scriptHash = await _hashText(scriptText);
      if (scriptHash) {
        const uid = _currentUser.id;
        const storedKey = 'so_script_hash_' + uid;
        const storedSubKey = 'so_script_sub_' + uid;
        const prevHash = localStorage.getItem(storedKey);
        const prevSubId = localStorage.getItem(storedSubKey);
        if (prevHash === scriptHash && prevSubId) {
          // Banner already shows — just note; proceed unless user backs out from upload
          window._pendingScriptHash = scriptHash;
          window._pendingScriptSubId = prevSubId;
          // Show non-blocking banner in upload UI (may be hidden behind processing screen)
          // We store these so _onApiDone can skip re-save if already saved
        }
        window._currentScriptHash = scriptHash;
      }
    }

    // Estimate page count (~1500 chars per formatted screenplay page)
    window._scriptPageCount = Math.max(1, Math.round(scriptText.trim().length / 1500));

    // Call Supabase Edge Function
   const { data, error: fnError } = await supabaseClient.functions.invoke('grade-script', {
  body: { script_text: scriptText, title, user_email: _currentUser?.email || null, script_type: _scriptType, is_sample: !!window._isSampleRun }
});

    // Plan/usage limit (HTTP 429) → friendly message, not a raw error
    if (fnError) {
      const status = fnError.context && fnError.context.status;
      if (status === 429) {
        let limitMsg = '';
        try { const b = await fnError.context.clone().json(); if (b && b.message) limitMsg = b.message; } catch (_e) {}
        _showLimitReached(limitMsg);
        return;
      }
      throw new Error(fnError.message || 'Edge function error');
    }
    if (data && data.error === 'limit_reached') { _showLimitReached(data.message || ''); return; }
    if (data?.error) throw new Error(data.error);

    _onApiDone(data);
    // Edge function saves server-side and returns submission_id — use it directly.
    // Only fall back to client-side save if the edge function didn't return one.
    if (data.submission_id) {
      _currentSubId = data.submission_id;
    } else {
      _saveSubmission(title, data);
    }

    // Store hash so next upload of the same script shows a warning
    if (window._currentScriptHash && _currentUser?.id) {
      const uid = _currentUser.id;
      localStorage.setItem('so_script_hash_' + uid, window._currentScriptHash);
      // Sub ID may not be set yet (async save), store after a tick
      setTimeout(() => {
        if (_currentSubId) localStorage.setItem('so_script_sub_' + uid, _currentSubId);
      }, 2000);
      window._currentScriptHash = null;
    }

  } catch (err) {
    console.error('SceneOne analysis error:', err);
    // Show error in the processing screen so user understands what happened
    const ph = document.getElementById('proc-phrase');
    const bar = document.getElementById('proc-bar');
    if (ph) ph.textContent = 'Analysis failed: ' + (err?.message || 'Unknown error');
    if (bar) bar.style.background = 'var(--amber, #f59e0b)';
    setTimeout(() => {
      goTo('upload');
      showUploadError('Analysis failed: ' + (err?.message || 'Unknown error') + ' — check the browser console for details.');
    }, 2500);
  }
}

// ─── Friendly plan-limit handling (HTTP 429 from grade-script) ───
function _showLimitReached(msg) {
  goTo('upload');
  const zone = document.querySelector('.drop-zone');
  let box = document.getElementById('limit-reached-msg');
  if (!box) {
    box = document.createElement('div');
    box.id = 'limit-reached-msg';
    box.style.cssText = 'margin-top:16px;padding:16px 18px;border-radius:12px;border:1px solid rgba(62,237,231,0.35);background:rgba(62,237,231,0.08);color:var(--text,#e8e8ea);font-size:14px;line-height:1.55;text-align:center;';
    if (zone && zone.parentNode) zone.parentNode.insertBefore(box, zone.nextSibling);
    else document.body.appendChild(box);
  }
  const detail = esc(msg || "You’ve used all of this month’s script analyses on your current plan.");
  box.innerHTML = '<div style="font-weight:700;margin-bottom:8px;">You&#39;ve reached this month&#39;s limit</div>'
    + '<div style="opacity:.85;margin-bottom:16px;">' + detail + ' Your limit resets at the start of next month.</div>'
    + '<button id="limit-see-plans" style="padding:9px 20px;border-radius:999px;border:none;background:var(--cyan,#3eede7);color:#08080a;font-weight:700;cursor:pointer;">See Plans →</button>';
  box.style.display = 'block';
  const btn = document.getElementById('limit-see-plans');
  if (btn) btn.onclick = function(){ box.style.display = 'none'; goTo('pricing'); };
}

// ─── UPDATE TOS for co-writers ───
// This is handled in legal doc — prototype just shows the flow


// ─── VIEW ROUTER ───
(function(){
  // Embedded in the case-study iframe? Apply demo-focused styling.
  try{ if(window.self!==window.top){ document.documentElement.classList.add('embedded'); document.body.classList.add('embedded'); } }
  catch(e){ document.documentElement.classList.add('embedded'); document.body.classList.add('embedded'); }

  function routeView(){
    try{
      var v = new URLSearchParams(location.search).get('view');
      if(!v) return;
      var map = { exec:'exec-profile', 'exec-profile':'exec-profile', dashboard:'dashboard', discovery:'dashboard', writer:'writer-profile', 'writer-profile':'writer-profile', upload:'upload' };
      var screen = map[v];
      if(!screen || typeof goTo!=='function' || !document.getElementById('screen-'+screen)) return;
      var cur = document.querySelector('.screen.active');
      if(!cur || cur.id !== 'screen-'+screen) goTo(screen);
    }catch(e){}
  }
  // Re-assert a few times to beat the app's async auth-init, then stop so
  // normal in-app navigation still works.
  [0,300,700,1300,2200].forEach(function(t){ setTimeout(routeView, t); });
})();
function openPricingModal(){document.getElementById('pricing-modal').classList.add('active');}
function closePricingModal(e){if(!e||e.target.id==='pricing-modal')document.getElementById('pricing-modal').classList.remove('active');}