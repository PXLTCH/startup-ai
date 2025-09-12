
let sessionId=null, awaitingConfirm=false, lastRefinedSuggestion="", awaitingLogo=false, selectedLogoStyle=null; let editMode=false;
const chat=$('#chat'), input=$('#input'), sendBtn=$('#send'), confirmBtn=$('#confirm'), editBtn=$('#edit'), skipBtn=$('#skip'), packBtn=$('#packBtn');
const nameChoices=$('#nameChoices'), logoChoices=$('#logoChoices'), logoStyleChoices=$('#logoStyleChoices'), regenNames=$('#regenNames'), regenLogos=$('#regenLogos');
const progressBar=$('#progressBar'), progressText=$('#progressText'), progressLabel=$('#progressLabel');
function on(el, ev, fn){ if(el) el.addEventListener(ev, fn); }
let lastSuggestions=[], lastLogos=[];

function $(q){ return document.querySelector(q); }
function addMsg(role,text){ const d=document.createElement('div'); d.className=`msg ${role}`; const b=document.createElement('div'); b.className='bubble'; b.textContent=text; d.appendChild(b); chat.appendChild(d); chat.scrollTop=chat.scrollHeight; }

async function startSession(){ addMsg('ai',"Welcome! I'm your Startup Orchestra coach. We'll go step-by-step to build an investor-ready profile. If you don't have a name yet, just say so—after your mission I'll generate tailored name ideas for you."); const r=await fetch('/api/session'); const j=await r.json(); sessionId=j.sessionId; await fetchNextQuestion(); }

async function fetchNextQuestion(){ const r=await fetch(`/api/next-question?sessionId=${sessionId}`); const j=await r.json(); if(j.done){ addMsg('ai', j.message||'Interview complete.'); progressLabel.textContent='Done'; progressBar.style.width='100%'; progressText.textContent='100%'; input.disabled=true; sendBtn.disabled=true; confirmBtn.disabled=true; skipBtn.disabled=true; packBtn.disabled=false; return;} progressLabel.textContent=`Question ${j.index+1} of ${j.total}`; const pct=Math.max(0, Math.min(100, Math.round((j.index)/j.total*100))); progressBar.style.width=pct+'%'; progressText.textContent=pct+'%'; addMsg('ai', j.text); awaitingConfirm=false; confirmBtn.disabled=true; editBtn.style.display='none'; }

on(sendBtn,'click', async ()=>{
  const text=input.value.trim(); if(!text && !awaitingConfirm) return; if(text){ addMsg('me', text); input.value=''; }
  if(logoChoices.style.display==='flex' && text){ const n=parseInt(text,10); if(!isNaN(n)&&n>=1&&n<=lastLogos.length){ await selectLogo(n-1); return; } }
  // If we are editing a pending draft, update it locally and do not hit the API
  if(awaitingConfirm && editMode){
    if(text){ lastRefinedSuggestion = text; addMsg('ai','Draft updated. Press Confirm to save it.'); input.value=''; }
    editMode = false;
    return;
  }
  if(nameChoices.style.display==='flex' && text){ const n=parseInt(text,10); if(!isNaN(n)&&n>=1&&n<=lastSuggestions.length){ await selectName(n-1); return; } const i=lastSuggestions.findIndex(s=>s.toLowerCase()===text.toLowerCase()); if(i>=0){ await selectName(i); return; } }
  try {
    const r=await fetch('/api/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,text})});
    const j=await r.json();
    if(j.error){ addMsg('ai', j.error); return; }
    if(j.chooseLogo){
      awaitingLogo=true; regenLogos.style.display='inline-block';
      showLogoStyleChoices(j.styles || ['Wordmark','Monogram','Icon+Wordmark','Emblem','Symbol-only']);
      return;
    }
    if(j.needConfirm){ if(j.mentor) addMsg('ai', j.mentor); awaitingConfirm=true; confirmBtn.disabled=false; lastRefinedSuggestion=j.mentor||''; editBtn.style.display='inline-block'; } else { await fetchNextQuestion(); }
  } catch (e) { addMsg('ai','Server not reachable. Is it running on this port?'); }
});

on(confirmBtn,'click', async ()=>{
  if(!awaitingConfirm) return;
  try {
    const r=await fetch('/api/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,refinedText:lastRefinedSuggestion})});
    const j=await r.json();
    if(j.chooseName && Array.isArray(j.suggestions)){ addMsg('ai','Thanks for your mission. Here are tailored name ideas — pick one (or type the number):'); renderNames(j.suggestions); regenNames.style.display='inline-block'; return; }
    if(j.chooseLogo){ addMsg('ai', j.message || "Pick a logo style to begin:"); awaitingLogo=true; regenLogos.style.display='inline-block'; showLogoStyleChoices(j.styles || ['Wordmark','Monogram','Icon+Wordmark','Emblem','Symbol-only']); return; }
    if(j.done){ addMsg('ai', j.message||'Interview complete.'); progressLabel.textContent='Done'; progressBar.style.width='100%'; progressText.textContent='100%'; confirmBtn.disabled=true; packBtn.disabled=false; return; }
    addMsg('ai', j.text); awaitingConfirm=false; confirmBtn.disabled=true; editBtn.style.display='none'; await fetchNextQuestion();
  } catch (e) { addMsg('ai','Server not reachable.'); }
});

function showLogoStyleChoices(styles){
  logoStyleChoices.innerHTML='';
  styles.forEach(s=>{
    const b=document.createElement('button'); b.textContent=s;
    b.onclick=async ()=>{
      selectedLogoStyle=s;
      addMsg('me', `Logo style: ${s}`);
      try{
        const r=await fetch('/api/logo/style',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,style:s})});
        await r.json();
      }catch(e){}
      await regenerateLogos();
    };
    logoStyleChoices.appendChild(b);
  });
  logoTools.style.display='block'; buildPaletteCard(); logoStyleChoices.style.display='flex';
  addMsg('ai','Choose a logo style, then I will show you 3 options. You can regenerate for more.');
}

async function regenerateLogos(){
  if(!awaitingLogo) return;
  lastLogos = [];
  logoChoices.innerHTML='';
  const s = selectedLogoStyle || 'Wordmark'; const keepLayout = !!(keepLayoutBox && keepLayoutBox.checked);
  addMsg('ai',`Generating ${s} logos…`);
  try {
    const r=await fetch('/api/generate/logos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId})});
    const j=await r.json();
    if(Array.isArray(j.files) && j.files.length){ renderLogos(j.files, true); refreshFavorites(); } else { addMsg('ai', j.error || 'No logo variants were generated yet. Try again.'); }
  } catch (e) { addMsg('ai','Server not reachable.'); }
}

on(regenLogos,'click', regenerateLogos);

on(regenNames,'click', async ()=>{
  addMsg('ai','Generating another set of name ideas…');
  try {
    const r=await fetch('/api/generate/name-ideas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId})});
    const j=await r.json();
    if(Array.isArray(j.suggestions) && j.suggestions.length){ addMsg('ai', `Received ${j.suggestions.length} new options.`); renderNames(j.suggestions); } else { addMsg('ai', j.error || 'Could not generate new names.'); }
  } catch (e) { addMsg('ai','Server not reachable.'); }
});

async function selectName(index){
  nameChoices.style.display='none'; regenNames.style.display='none';
  addMsg('me', `I choose: ${lastSuggestions[index]}`);
  try {
    const r=await fetch('/api/select-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,choice:index})});
    const j=await r.json();
    if(j.done){ addMsg('ai', j.message||'Interview complete.'); progressLabel.textContent='Done'; progressBar.style.width='100%'; progressText.textContent='100%'; packBtn.disabled=false; return; }
    await fetchNextQuestion();
  } catch (e) { addMsg('ai','Server not reachable.'); }
}


async function selectLogo(index){
  const chosen = lastLogos && lastLogos[index];
  // Try to extract the original file path from the /download?path=... URL
  let chosenPath = null;
  try {
    const u = new URL(chosen, location.href);
    chosenPath = u.searchParams.get('path');
  } catch {}
  if (!chosenPath && typeof chosen === 'string') {
    // fallback: if lastLogos stored the raw path
    chosenPath = chosen;
  }

  // Hide logo UI immediately
  if (logoChoices) logoChoices.style.display='none';
  if (logoStyleChoices) logoStyleChoices.style.display='none';
  if (logoTools) logoTools.style.display='none';
  if (regenLogos) regenLogos.style.display='none';
  awaitingLogo=false;

  addMsg('me', `I select logo #${index+1}`);
  try {
    if (chosen) { addImg('ai', chosen, 'Selected logo'); }
  } catch {}

  try {
    const r = await fetch('/api/select-logo', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId, choice: chosenPath ?? index })
    });
    const j = await r.json();
    // Even if server responds with error, proceed to fetchNextQuestion to avoid getting stuck
    if(j && j.error){ addMsg('ai', j.error); }
  } catch (e) {
    addMsg('ai','Could not save logo selection, but continuing.');
  }

  await fetchNextQuestion();
}


function renderNames(arr){
  lastSuggestions = arr.slice(); nameChoices.innerHTML='';
  arr.forEach((s,i)=>{ const b=document.createElement('button'); b.textContent=`${i+1}. ${s}`; b.onclick=()=>selectName(i); nameChoices.appendChild(b); });
  nameChoices.style.display='flex'; regenNames.style.display='inline-block';
}
function renderLogos(files, preBusted=false){
  lastLogos = files.slice(); logoChoices.innerHTML='';
  const cacheBuster = `&v=${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  files.forEach((url,i)=>{
    const card=document.createElement('div'); card.className='logo-card';
    const img=document.createElement('img'); img.src = url + cacheBuster; img.alt=`Logo ${i+1}`;
    const btn=document.createElement('button'); btn.className='button-accent'; btn.textContent=`Select #${i+1}`; btn.onclick=()=>selectLogo(i);
    card.appendChild(img); card.appendChild(btn); logoChoices.appendChild(card);
  });
  logoChoices.style.display='flex'; regenLogos.style.display='inline-block';
}
startSession();


// --- Modal logic (design-only) ---
const getStartedBtn = document.querySelector('#getStarted');
const modal = document.querySelector('#signupModal');
const modalClose = document.querySelector('#modalClose');
if (getStartedBtn && modal) {
  getStartedBtn.addEventListener('click', (e)=>{ e.preventDefault(); modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); });
  modalClose.addEventListener('click', ()=>{ modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); });
  modal.addEventListener('click', (e)=>{ if(e.target.classList.contains('modal-backdrop')){ modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); } });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !modal.classList.contains('hidden')){ modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); } });
}


// --- Sign In modal (design-only) ---
const navSignIn = document.querySelector('#navSignIn');
const signinModal = document.querySelector('#signinModal');
const signinClose = document.querySelector('#signinClose');
const openRegisterFromSignin = document.querySelector('#openRegisterFromSignin');
const signupModal = document.querySelector('#signupModal');

if (navSignIn && signinModal) {
  navSignIn.addEventListener('click', (e)=>{ e.preventDefault(); signinModal.classList.remove('hidden'); signinModal.setAttribute('aria-hidden','false'); });
  signinClose.addEventListener('click', ()=>{ signinModal.classList.add('hidden'); signinModal.setAttribute('aria-hidden','true'); });
  signinModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('modal-backdrop')){ signinModal.classList.add('hidden'); signinModal.setAttribute('aria-hidden','true'); } });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !signinModal.classList.contains('hidden')){ signinModal.classList.add('hidden'); signinModal.setAttribute('aria-hidden','true'); } });

  if (openRegisterFromSignin && signupModal) {
    openRegisterFromSignin.addEventListener('click', (e)=>{
      e.preventDefault();
      signinModal.classList.add('hidden'); signinModal.setAttribute('aria-hidden','true');
      signupModal.classList.remove('hidden'); signupModal.setAttribute('aria-hidden','false');
    });
  }
}


// --- Pricing modal (design-only) ---
const navPricing = document.querySelector('#navPricing');
const pricingModal = document.querySelector('#pricingModal');
const pricingClose = document.querySelector('#pricingClose');

if (navPricing && pricingModal) {
  navPricing.addEventListener('click', (e)=>{ e.preventDefault(); pricingModal.classList.remove('hidden'); pricingModal.setAttribute('aria-hidden','false'); });
  pricingClose.addEventListener('click', ()=>{ pricingModal.classList.add('hidden'); pricingModal.setAttribute('aria-hidden','true'); });
  pricingModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('modal-backdrop')){ pricingModal.classList.add('hidden'); pricingModal.setAttribute('aria-hidden','true'); } });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !pricingModal.classList.contains('hidden')){ pricingModal.classList.add('hidden'); pricingModal.setAttribute('aria-hidden','true'); } });
}


// --- My Answers modal (design-only view) ---
const navMyAnswers = document.querySelector('#navMyAnswers');
const answersModal = document.querySelector('#answersModal');
const answersClose = document.querySelector('#answersClose');
const answersList = document.querySelector('#answersList');
const answersCount = document.querySelector('#answersCount');

async function openAnswers(){
  if(!sessionId){ return; }
  try{
    const r = await fetch(`/api/answers?sessionId=${sessionId}`);
    const j = await r.json();
    renderAnswersModal(j);
    answersModal.classList.remove('hidden'); answersModal.setAttribute('aria-hidden','false');
  }catch(e){
    // fall back: show error
    answersList.innerHTML = '<div class="answer-item"><div class="answer-body">Could not load answers.</div></div>';
    answersModal.classList.remove('hidden'); answersModal.setAttribute('aria-hidden','false');
  }
}

function renderAnswersModal(data){
  if(!data || !Array.isArray(data.items)){ answersList.innerHTML=''; return; }
  answersCount.textContent = `${data.confirmed}/${data.total} confirmed`;
  const html = data.items.map(x=>{
    const status = x.confirmed ? 'Confirmed' : 'Draft';
    const badge = `<span class=\"badge\">${status}</span>`;
    const val = (x.value||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const raw = x.refined && x.refined.trim()!=='' ? `<div class=\"answer-raw\">Original: ${(x.raw||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : '';
    return `<div class=\"answer-item\">
      <div class=\"answer-head\"><span class=\"idx\">Q${x.index}</span><span class=\"q\">${x.question_text}</span>${badge}</div>
      <div class=\"answer-body\">${val || '<em>No answer yet</em>'}</div>
      ${raw}
      <div class=\"edit-row\"><button class=\"edit-btn\" data-qid=\"${x.question_id}\">Edit</button></div>
    </div>`;
  }).join('');
  answersList.innerHTML = html;
  // Bind edit buttons
  answersList.querySelectorAll('.edit-btn').forEach(btn=>{
    btn.addEventListener('click', async () => {
      const qid = btn.getAttribute('data-qid');
      try{
        const r = await fetch('/api/jump-to', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sessionId, questionId: qid }) });
        const j = await r.json();
        if(j.ok){
          answersModal.classList.add('hidden'); answersModal.setAttribute('aria-hidden','true');
          // Show the question immediately
          addMsg('ai', `Revisiting: ${j.question.text}`);
          if(j.lastValue){ input.value = j.lastValue; input.focus(); }
          // Progress UI
          progressLabel.textContent = `Question ${j.question.index+1} of ${j.question.total}`;
          const pct=Math.max(0, Math.min(100, Math.round((j.question.index)/j.question.total*100)));
          progressBar.style.width=pct+'%'; progressText.textContent=pct+'%';
        }
      }catch(e){ /* ignore */ }
    });
  });
}

if(navMyAnswers && answersModal){
  navMyAnswers.addEventListener('click', (e)=>{ e.preventDefault(); openAnswers(); });
  answersClose.addEventListener('click', ()=>{ answersModal.classList.add('hidden'); answersModal.setAttribute('aria-hidden','true'); });
  answersModal.addEventListener('click', (e)=>{ if(e.target.classList.contains('modal-backdrop')){ answersModal.classList.add('hidden'); answersModal.setAttribute('aria-hidden','true'); } });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !answersModal.classList.contains('hidden')){ answersModal.classList.add('hidden'); answersModal.setAttribute('aria-hidden','true'); } });
}


// Export buttons
const btnExportJson = document.querySelector('#answersExportJson');
const btnExportPdf = document.querySelector('#answersExportPdf');
if (btnExportJson) {
  btnExportJson.addEventListener('click', async ()=>{
    try{
      const r = await fetch(`/api/export/answers.json?sessionId=${sessionId}`);
      const j = await r.json();
      if (j && j.download) { window.open(j.download, '_blank'); }
    }catch(e){}
  });
}
if (btnExportPdf) {
  btnExportPdf.addEventListener('click', async ()=>{
    try{
      const r = await fetch(`/api/export/answers.pdf?sessionId=${sessionId}`);
      const j = await r.json();
      if (j && j.download) { window.open(j.download, '_blank'); }
    }catch(e){}
  });
}


// Edit current investor-ready draft: preload into input, then user presses Send to update the draft (no extra LLM call)
on(editBtn,'click', ()=>{
  if(!awaitingConfirm){ return; }
  // Put the last refined suggestion into the input for manual edits
  try {
    const clean = (lastRefinedSuggestion||'').replace(/\s*Investor-ready draft.*$/i, '').trim();
    input.value = clean || lastRefinedSuggestion || '';
  } catch { input.value = lastRefinedSuggestion || ''; }
  editMode = true;
  input.focus();
  addMsg('ai','Make your edits in the box, press Send, then Confirm to save.');
});


// Skip current question without saving
on(skipBtn,'click', async ()=>{
  try{
    const r = await fetch('/api/skip', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sessionId }) });
    const j = await r.json();
    awaitingConfirm = false; confirmBtn.disabled = true; editBtn.style.display='none';
    // Clear any choose UI
    nameChoices.style.display='none'; logoChoices.style.display='none'; logoStyleChoices.style.display='none';
    regenNames.style.display='none'; regenLogos.style.display='none'; awaitingLogo = false;
    // Render the next question once via our normal fetch
    await fetchNextQuestion();
  }catch(e){ addMsg('ai','Could not skip right now.'); }
});


async function refreshFavorites(){
  try{
    const r=await fetch(`/api/favorites?sessionId=${sessionId}`);
    const j=await r.json();
    const items = j.items||[];
    if(items.length===0){ favoritesTray.style.display='none'; favoritesTray.innerHTML=''; return; }
    favoritesTray.style.display='block';
    const grid = items.map(it=>`<div class="fav-item"><img src="/download?path=${encodeURIComponent(it.path)}&v=${Date.now()}"/><button class="rm" data-path="${it.path}">✕</button></div>`).join('');
    favoritesTray.innerHTML = `<div class="fav-title">Favorites</div><div class="fav-grid">${grid}</div>`;
    favoritesTray.querySelectorAll('.rm').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        await fetch('/api/favorites/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId, path: btn.getAttribute('data-path')})});
        refreshFavorites();
      });
    });
  }catch{}
}

on(zipCurrent,'click', async ()=>{
  try{
    const r=await fetch('/api/export/zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ sessionId, source:'current' })});
    const j=await r.json(); if(j.download){ window.open(j.download,'_blank'); }
  }catch{ addMsg('ai','Nothing to download yet.'); }
});
on(zipFavorites,'click', async ()=>{
  try{
    const r=await fetch('/api/export/zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ sessionId, source:'favorites' })});
    const j=await r.json(); if(j.download){ window.open(j.download,'_blank'); } else if(j.error){ addMsg('ai', j.error); }
  }catch{ addMsg('ai','No favorites to download yet.'); }
});

const PRESETS = [
  ['#6b4df0','#a855f7','#22d3ee'],
  ['#f43f5e','#a855f7','#6366f1'],
  ['#10b981','#14b8a6','#0ea5e9'],
  ['#f59e0b','#ef4444','#8b5cf6'],
  ['#06b6d4','#3b82f6','#8b5cf6']
];
const FONTS = ['Inter','Montserrat','Poppins','Nunito','Raleway'];
function buildPaletteCard(){
  paletteCard.style.display='block';
  const presetHtml = PRESETS.map((p,idx)=>`<div class="swatch" data-idx="${idx}" title="${p.join(' ')}" style="background: linear-gradient(90deg, ${p[0]}, ${p[1]}, ${p[2]});"></div>`).join('');
  paletteCard.innerHTML = `
    <div class="row"><strong>Colors (optional):</strong> ${presetHtml}</div>
    <div class="palette-form">
      <input type="color" id="c1" value="#6b4df0"/>
      <input type="color" id="c2" value="#a855f7"/>
      <input type="color" id="c3" value="#22d3ee"/>
      <select id="fontSel">${FONTS.map(f=>`<option value="${f}">${f}</option>`).join('')}</select>
      <label><input type="checkbox" id="lockPalette"/> Lock palette</label>
      <label><input type="checkbox" id="lockFont"/> Lock font</label>
      <button class="btn" id="savePrefs">Save</button>
    </div>`;
  paletteCard.querySelectorAll('.swatch').forEach(sw=>{
    sw.addEventListener('click',()=>{
      const idx = +sw.getAttribute('data-idx');
      const p = PRESETS[idx];
      paletteCard.querySelector('#c1').value = p[0];
      paletteCard.querySelector('#c2').value = p[1];
      paletteCard.querySelector('#c3').value = p[2];
      paletteCard.querySelectorAll('.swatch').forEach(x=>x.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });
  paletteCard.querySelector('#savePrefs').addEventListener('click', async ()=>{
    const palette=[paletteCard.querySelector('#c1').value, paletteCard.querySelector('#c2').value, paletteCard.querySelector('#c3').value];
    const font = paletteCard.querySelector('#fontSel').value;
    const lockPalette = paletteCard.querySelector('#lockPalette').checked;
    const lockFont = paletteCard.querySelector('#lockFont').checked;
    try{
      await fetch('/api/logo-prefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ sessionId, palette, font, lockPalette, lockFont })});
      addMsg('ai','Saved palette & font preferences.');
    }catch{ addMsg('ai','Could not save preferences.'); }
  });
}
