
/* dotenv removed */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import archiver from 'archiver';

/* Lightweight .env loader (no external dependency) */
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) {
        const k = m[1];
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) v = v.slice(1,-1);
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch {}

import dayjs from 'dayjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './startup_orchestra.db';
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'generated'));
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI client
if (!process.env.OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// DB init + schema migration
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'active',
  current_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  question_id TEXT,
  raw_value TEXT,
  refined_value TEXT,
  confirmed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`);
function ensureColumn(table, col, def){
  const exists = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info(?) WHERE name=?`).get(table, col).c;
  if (!exists) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
}
ensureColumn('sessions','pending_name', "INTEGER DEFAULT 0");
ensureColumn('sessions','name_suggestions', "TEXT DEFAULT ''");
ensureColumn('sessions','name_history', "TEXT DEFAULT '[]'");
ensureColumn('sessions','pending_logo', "INTEGER DEFAULT 0");
ensureColumn('sessions','logo_variants', "TEXT DEFAULT ''");
ensureColumn('sessions','logo_style', "TEXT DEFAULT 'Wordmark'");
ensureColumn('sessions','logo_gen', "INTEGER DEFAULT 0");
ensureColumn('sessions','palette_json', 'TEXT');
ensureColumn('sessions','font_lock', 'TEXT');
ensureColumn('sessions','palette_locked', 'INTEGER DEFAULT 0');
ensureColumn('sessions','font_locked', 'INTEGER DEFAULT 0');
ensureColumn('sessions','keep_layout', 'INTEGER DEFAULT 0');
ensureColumn('sessions','layout_seed', 'INTEGER DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS favorites(
      session_id TEXT,
      path TEXT,
      style TEXT,
      created_at INTEGER
    )`);

// Load questions
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname,'questions.json'),'utf-8'));
const FLAT_QUESTIONS = QUESTIONS.flatMap(s => s.questions);
const TOTAL_QUESTIONS = FLAT_QUESTIONS.length;

// Mentor prompts
const MENTOR_SYSTEM_PROMPT = `You are "Startup Orchestra" — a professional startup mentor. Stay strictly on the interview questions. Style: concise, investor-focused. For each answer, propose a sharper rewrite if needed, then add: "Investor-ready draft. Confirm to save, or Edit to adjust."`;
const PACK_SYSTEM_PROMPT = `You are a professional startup mentor. Create concise, investor-ready content only from the provided profile. Do not invent numbers. If numbers are missing, state clear assumptions as placeholders.`;

// Helpers
function getSession(id){ return db.prepare('SELECT * FROM sessions WHERE id=?').get(id); }
function createSession(){ const id=uuidv4(); db.prepare('INSERT INTO sessions (id,status,current_index) VALUES (?,?,?)').run(id,'active',0); return id; }
function getCurrentQuestion(s){ if (s.current_index>=TOTAL_QUESTIONS) return null; return FLAT_QUESTIONS[s.current_index]; }
function advance(id){ db.prepare('UPDATE sessions SET current_index=current_index+1 WHERE id=?').run(id); }
function saveAnswer(sessionId,qid,raw,refined,confirmed){ db.prepare('INSERT INTO answers (id,session_id,question_id,raw_value,refined_value,confirmed) VALUES (?,?,?,?,?,?)').run(uuidv4(),sessionId,qid,raw??'',refined??'',confirmed?1:0); }
function getAllConfirmedAnswers(sessionId){
  const rows=db.prepare(`SELECT question_id, COALESCE(NULLIF(refined_value, ''), raw_value) AS value FROM answers WHERE session_id=? AND confirmed=1`).all(sessionId);
  const m={}; for(const r of rows) m[r.question_id]=r.value||''; return m;
}
function hasConfirmedName(sessionId){ return !!db.prepare('SELECT 1 FROM answers WHERE session_id=? AND question_id=? AND confirmed=1 LIMIT 1').get(sessionId,'vision.name'); }
function setPendingName(id,flag){ db.prepare('UPDATE sessions SET pending_name=? WHERE id=?').run(flag?1:0,id); }
function getPendingName(id){ const r=db.prepare('SELECT pending_name FROM sessions WHERE id=?').get(id); return r?!!r.pending_name:false; }
function setNameSuggestions(id,arr){ db.prepare('UPDATE sessions SET name_suggestions=? WHERE id=?').run(JSON.stringify(arr),id); }
function getNameSuggestions(id){ const r=db.prepare('SELECT name_suggestions FROM sessions WHERE id=?').get(id); try{return r&&r.name_suggestions?JSON.parse(r.name_suggestions):[]}catch{return[];} }
function getNameHistory(id){ const r=db.prepare('SELECT name_history FROM sessions WHERE id=?').get(id); try{return r&&r.name_history?JSON.parse(r.name_history):[]}catch{return[];} }
function addToNameHistory(id, arr){ const hist=getNameHistory(id); const merged=[...new Set(hist.concat(arr||[]))]; db.prepare('UPDATE sessions SET name_history=? WHERE id=?').run(JSON.stringify(merged), id); }
function setPendingLogo(id,flag){ db.prepare('UPDATE sessions SET pending_logo=? WHERE id=?').run(flag?1:0,id); }
function getPendingLogo(id){ const r=db.prepare('SELECT pending_logo FROM sessions WHERE id=?').get(id); return r?!!r.pending_logo:false; }
function setLogoVariants(id,arr){ db.prepare('UPDATE sessions SET logo_variants=? WHERE id=?').run(JSON.stringify(arr),id); }
function getLogoVariants(id){ const r=db.prepare('SELECT logo_variants FROM sessions WHERE id=?').get(id); try{return r&&r.logo_variants?JSON.parse(r.logo_variants):[]}catch{return[];} }
function setLogoStyle(id,style){ db.prepare('UPDATE sessions SET logo_style=? WHERE id=?').run(style,id); }
function getLogoStyle(id){ const r=db.prepare('SELECT logo_style FROM sessions WHERE id=?').get(id); return r?r.logo_style:'Wordmark'; }
function bumpLogoGen(id){ db.prepare('UPDATE sessions SET logo_gen = COALESCE(logo_gen,0)+1 WHERE id=?').run(id); const r=db.prepare('SELECT logo_gen FROM sessions WHERE id=?').get(id); return r? r.logo_gen : 0; }

function setLogoPrefs(id,{palette, font, lockPalette, lockFont}){
  const pal = (Array.isArray(palette)&&palette.length) ? JSON.stringify(palette) : null;
  const fnt = (typeof font==='string' && font) ? font : null;
  db.prepare('UPDATE sessions SET palette_json=?, font_lock=?, palette_locked=?, font_locked=? WHERE id=?')
    .run(pal, fnt, lockPalette?1:0, lockFont?1:0, id);
}
function getLogoPrefs(id){
  const r = db.prepare('SELECT palette_json, font_lock, palette_locked, font_locked, keep_layout, layout_seed FROM sessions WHERE id=?').get(id) || {};
  return {
    palette: r.palette_json ? JSON.parse(r.palette_json) : null,
    font: r.font_lock || null,
    lockPalette: r.palette_locked ? true : false,
    lockFont: r.font_locked ? true : false,
    keepLayout: r.keep_layout ? true : false,
    layoutSeed: r.layout_seed || 0
  };
}
function setKeepLayout(id, on){
  db.prepare('UPDATE sessions SET keep_layout=? WHERE id=?').run(on?1:0, id);
}
function setLayoutSeed(id, seed){
  db.prepare('UPDATE sessions SET layout_seed=? WHERE id=?').run(seed>>>0, id);
}
function getLayoutSeed(id){ const r = db.prepare('SELECT layout_seed FROM sessions WHERE id=?').get(id); return r? (r.layout_seed>>>0) : 0; }

function getLogoGen(id){ const r=db.prepare('SELECT logo_gen FROM sessions WHERE id=?').get(id); return r? (r.logo_gen||0) : 0; }

async function chat(messages, temperature=0.2){
  const c=await openai.chat.completions.create({model:process.env.OPENAI_MODEL_CHAT||'gpt-4o',messages,temperature});
  return c.choices[0].message.content?.trim()||'';
}

// Strict <=12-char name generator
async function generateNames(mission, avoidList){
  const diversityKey = Math.random().toString(36).slice(2,8);
  const messages=[
    {role:'system', content:PACK_SYSTEM_PROMPT},
    {role:'user', content:
      `DiversityKey=${diversityKey}. Return ONLY a JSON array of 5 brandable startup names as plain strings.
       HARD RULES: (1) each name must be <= 12 characters total, (2) no spaces or hyphens, (3) letters/numbers only,
       (4) avoid these names and similar stems: ${JSON.stringify(avoidList||[])},
       (5) prefer relevance to this mission: ${mission}. No prose, no numbering.`
    }
  ];
  const txt = await chat(messages, 0.9);

  function sanitizeCandidate(s){
    if (!s) return "";
    s = String(s).trim()
      .replace(/^[\s\-\*\d\.]+/, '')
      .replace(/"/g, '');
    const camelSplit = s.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/)[0];
    let out = camelSplit.replace(/[^A-Za-z0-9]/g, '');
    if (out.length > 12) out = out.slice(0, 12);
    if (out) out = out[0].toUpperCase() + out.slice(1);
    return out;
  }
  function localFallback(mission, avoid){
    const kws = (mission || '').toLowerCase().match(/[a-z]{3,}/g) || [];
    const uniq = Array.from(new Set(kws)).slice(0, 5);
    const roots = uniq.length ? uniq : ['nova','flow','clinic','med','vita','swift','pilot','orbit','forge','pulse','nest','link'];
    const suffixes = ['ly','io','ify','hub','lab','grid','core','sync','byte','gen','nest','way','zen','rise'];
    const seen = new Set((avoid||[]).map(x=>x.toLowerCase()));
    const out = [];
    for (let i=0; i<50 && out.length<5; i++){
      const r = roots[Math.floor(Math.random()*roots.length)];
      const s = suffixes[Math.floor(Math.random()*suffixes.length)];
      let name = (r + s).replace(/[^a-z0-9]/g,'');
      name = name[0].toUpperCase() + name.slice(1);
      if (name.length>12) name = name.slice(0,12);
      if (name.length>=4 && !seen.has(name.toLowerCase()) && !out.find(x=>x.toLowerCase()===name.toLowerCase())){
        out.push(name);
      }
    }
    if (out.length < 5) {
      const fillers = ['Novaly','Fluxio','Clinix','Vitaria','Swiftly','Pulsar','Forgera','Linksy','Nestio','Corely'];
      for (const f of fillers) {
        if (out.length >= 5) break;
        const n = f.length>12 ? f.slice(0,12) : f;
        if (!out.find(x=>x.toLowerCase()===n.toLowerCase())) out.push(n);
      }
    }
    return out.slice(0,5);
  }

  let arr = [];
  try {
    const raw = JSON.parse(txt);
    if (Array.isArray(raw)) arr = raw.map(sanitizeCandidate).filter(Boolean);
  } catch {
    const lines = (txt || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    arr = lines.map(sanitizeCandidate).filter(Boolean);
  }

  const avoidSet = new Set((avoidList||[]).map(x=>String(x).toLowerCase()));
  const uniq = [];
  for (const n of arr) {
    const k = n.toLowerCase();
    if (n.length <= 12 && !avoidSet.has(k) && !uniq.find(x=>x.toLowerCase()===k)) uniq.push(n);
  }
  if (uniq.length < 5) {
    const extra = localFallback(mission, [...avoidSet, ...uniq]);
    for (const e of extra) {
      if (uniq.length >= 5) break;
      if (!uniq.find(x=>x.toLowerCase()===e.toLowerCase())) uniq.push(e);
    }
  }
  return uniq.slice(0,5);
}

// Logo helpers
function pickPaletteFromBrand(name){
  const palettes=[['#2563eb','#0f172a','#e6e9ef'],['#8b5cf6','#111827','#f9fafb'],['#22d3ee','#2563eb','#0b1220'],['#10b981','#064e3b','#ecfdf5'],['#f59e0b','#78350f','#fffbeb']];
  const idx=Math.abs((name||'brand').split('').reduce((a,c)=>a+c.charCodeAt(0),0))%palettes.length; return palettes[idx];
}
function safeSlug(s){ return (s||'company').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

function svgWordmark(name,a,b,c){ return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><circle cx="80" cy="150" r="40" fill="${a}"/><text x="150" y="170" font-size="64" fill="${c}" font-family="Helvetica, Arial">${name}</text></svg>`; }
function svgWordmarkSerif(name,a,b,c){ return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><rect x="60" y="90" width="100" height="100" fill="${a}"/><text x="190" y="170" font-size="60" fill="${c}" font-family="Georgia, serif">${name}</text></svg>`; }
function svgWordmarkGradient(name,a,b,c){ return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${c}"/></linearGradient></defs><rect width="100%" height="100%" fill="${b}"/><text x="60" y="170" font-size="72" fill="url(#g)" font-family="Verdana, Geneva, Tahoma, sans-serif">${name}</text></svg>`; }

function svgMonogram(name,a,b,c){
  const mono=(name||'U').trim()[0]?.toUpperCase()||'U';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><circle cx="120" cy="150" r="60" fill="${a}"/><text x="110" y="170" font-size="64" fill="${c}" font-family="Helvetica, Arial" font-weight="bold">${mono}</text><text x="220" y="170" font-size="64" fill="${c}" font-family="Helvetica, Arial">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><rect x="60" y="90" width="120" height="120" rx="12" fill="${a}"/><text x="103" y="172" font-size="72" fill="${c}" font-family="Georgia, serif" font-weight="bold">${mono}</text><text x="220" y="170" font-size="58" fill="${c}" font-family="Georgia, serif">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><polygon points="80,90 160,150 80,210" fill="${a}"/><text x="190" y="170" font-size="66" fill="${c}" font-family="Verdana, Geneva, Tahoma, sans-serif">${name}</text></svg>`
  ];
}

function svgIconWordmark(name,a,b,c){
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><path d="M70 150 l30 30 l50 -70" stroke="${a}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/><text x="190" y="170" font-size="60" fill="${c}" font-family="Helvetica, Arial">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><polyline points="70,190 110,160 150,175 190,130 230,140" fill="none" stroke="${a}" stroke-width="12"/><text x="260" y="170" font-size="60" fill="${c}" font-family="Georgia, serif">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><polygon points="80,110 140,110 110,170 170,170 100,230 120,180 80,180" fill="${a}"/><text x="200" y="170" font-size="64" fill="${c}" font-family="Verdana, Geneva, Tahoma, sans-serif">${name}</text></svg>`
  ];
}

function svgEmblem(name,a,b,c){
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><rect x="60" y="110" width="360" height="80" rx="40" fill="${a}"/><text x="80" y="165" font-size="48" fill="${c}" font-family="Helvetica, Arial">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><rect x="60" y="100" width="420" height="100" rx="12" fill="${a}"/><text x="80" y="165" font-size="56" fill="${c}" font-family="Georgia, serif">${name}</text></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><defs><linearGradient id="em" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${c}"/></linearGradient></defs><rect width="100%" height="100%" fill="${b}"/><rect x="60" y="110" width="420" height="80" rx="20" fill="url(#em)"/><text x="80" y="165" font-size="50" fill="${b}" font-family="Verdana, Geneva, Tahoma, sans-serif">${name}</text></svg>`
  ];
}

function svgSymbolOnly(name,a,b,c){
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><g transform="translate(120,90)"><circle cx="60" cy="60" r="60" fill="${a}"/><circle cx="90" cy="60" r="40" fill="${c}" opacity="0.7"/></g></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><g transform="translate(100,80)"><rect x="0" y="0" width="140" height="140" rx="16" fill="${a}"/><path d="M20 90 L70 30 L120 110 Z" fill="${c}" opacity="0.85"/></g></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="${b}"/><g transform="translate(80,70)"><polygon points="0,120 80,0 160,120" fill="${a}"/><polygon points="30,100 80,25 130,100" fill="${c}" opacity="0.7"/></g></svg>`
  ];
}


function generateLogoSvgs(name, style, gen, opts={}){
  function makeRng(seed){
    let x = seed >>> 0;
    return function(){ x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); }
  }
  const seed = (Date.now() ^ ((gen||0)+1)*2654435761) >>> 0;
  const optsPalette = (opts && Array.isArray(opts.paletteLock) && opts.paletteLock.length) ? opts.paletteLock : null;
  const optsFont = (opts && typeof opts.fontLock==='string' && opts.fontLock) ? opts.fontLock : null;
  const keepLayout = !!(opts && opts.keepLayout);
  const layoutSeed = keepLayout && Number.isFinite(opts && opts.layoutSeed) ? (opts.layoutSeed>>>0) : null;
  const rng = makeRng(seed);
  const rngLayout = layoutSeed!==null ? makeRng(layoutSeed) : makeRng(seed ^ 0x9E3779B9);
  const rngColor  = makeRng(seed ^ 0x85EBCA6B);
  const safe = (name||'Startup').trim();
  const baseName = safe || 'Startup';
  const initials = baseName.split(/\s+/).map(w=>w[0]||'').join('').slice(0,3).toUpperCase();
  const fonts=[{fam:'Inter',weight:800},{fam:'Montserrat',weight:700},{fam:'Poppins',weight:700},{fam:'Nunito',weight:800},{fam:'SF Pro Display',weight:700},{fam:'Raleway',weight:800}];
  const palettes=[['#6b4df0','#a855f7','#22d3ee'],['#f43f5e','#a855f7','#6366f1'],['#10b981','#14b8a6','#0ea5e9'],['#f59e0b','#ef4444','#8b5cf6'],['#06b6d4','#3b82f6','#8b5cf6']];
  function pick(arr){ return arr[Math.floor(rng()*arr.length)]; }
  function lerp(a,b,t){ return a+(b-a)*t; }
  function varyCase(s,m){ if(m===0) return s; if(m===1) return s.toUpperCase(); return s.replace(/\b(\w)(\w*)/g,(m,a,b)=>a.toUpperCase()+b.toLowerCase()); }
  function wordmarkSVG(txt, idx){
    const f = optsFont ? { fam: optsFont, weight: 800 } : pick(fonts);
    const palette = optsPalette ? optsPalette : pick(palettes);
    const gradId = `g${(gen||0)}_${idx}_${Math.floor(rng()*1e6)}`;
    const letterSp = (Math.round(lerp(-0.5, 2.0, rngLayout())*10)/10);
    const skew = Math.round(lerp(-6, 6, rngLayout()));
    const mode = Math.floor(rngLayout()*3); const textVal = varyCase(txt, mode);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%" stop-color="${palette[0]}"/><stop offset="50%" stop-color="${palette[1]}"/><stop offset="100%" stop-color="${palette[2]}"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="#0b0620"/>
  <g transform="translate(80,280) skewX(${skew})">
    <text x="0" y="0" fill="url(#${gradId})" font-family="${f.fam}" font-weight="${f.weight}" font-size="88" letter-spacing="${letterSp}">${textVal}</text>
  </g></svg>`;
  }
  function monogramSVG(txt, idx){
    const palette = optsPalette ? optsPalette : pick(palettes); const bg = palette[Math.floor(rngColor()*palette.length)]; const fg = palette[(Math.floor(rngColor()*palette.length+1))%palette.length];
    const size=540; const R=Math.floor(lerp(100,160,rngLayout())); const corner=Math.floor(lerp(20,40,rngLayout())); const weight=Math.floor(lerp(700,900,rngLayout()));
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${size}" viewBox="0 0 960 ${size}">
  <rect width="100%" height="100%" fill="#0b0620"/>
  <rect x="120" y="${(size/2)-R}" rx="${corner}" ry="${corner}" width="${R*2}" height="${R*2}" fill="${bg}"/>
  <text x="${120+R}" y="${(size/2)+28}" text-anchor="middle" font-family="Inter" font-weight="${weight}" font-size="120" fill="${fg}">${initials}</text>
  <text x="400" y="${(size/2)+25}" font-family="Montserrat" font-weight="800" font-size="66" fill="#ffffff">${txt}</text></svg>`;
  }
  function iconWordmarkSVG(txt, idx){
    const palette = optsPalette ? optsPalette : pick(palettes); const shapeType=Math.floor(rngLayout()*3); const col1=palette[0], col2=palette[1];
    const shapeX=120, shapeY=270, S=90; let shape='';
    if(shapeType===0){ shape = `<circle cx="${shapeX}" cy="${shapeY}" r="${S}" fill="${col1}"/>`; }
    else if(shapeType===1){ const pts=[]; for(let i=0;i<6;i++){ const a=Math.PI/3*i; pts.push(`${shapeX+S*Math.cos(a)},${shapeY+S*Math.sin(a)}`);} shape = `<polygon points="${'${pts.join( \' \' )}'}" fill="${col1}"/>`; }
    else { const pts=[[shapeX,shapeY-S],[shapeX-S,shapeY+S],[shapeX+S,shapeY+S]]; shape = `<polygon points="${'${pts.map(p=>p.join(\',\')).join( \' \' )}'}" fill="${col1}"/>`; }
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="100%" height="100%" fill="#0b0620"/>
  ${shape}
  <text x="${shapeX}" y="280" text-anchor="middle" font-family="Inter" font-weight="900" font-size="64" fill="${col2}">${initials}</text>
  <text x="270" y="300" font-family="Poppins" font-weight="800" font-size="72" fill="#fff">${txt}</text></svg>`;
  }
  function emblemSVG(txt, idx){
    const palette = optsPalette ? optsPalette : pick(palettes); const col = palette[Math.floor(rngColor()*palette.length)]; const w=760,h=220,x=100,y=160,r=24;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="100%" height="100%" fill="#0b0620"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="none" stroke="${col}" stroke-width="4"/>
  <text x="${x+24}" y="${y+120}" font-family="Raleway" font-weight="800" font-size="82" fill="#ffffff">${txt}</text>
  <text x="${x+w-24}" y="${y+120}" text-anchor="end" font-family="Inter" font-weight="800" font-size="42" fill="${col}">${initials}</text></svg>`;
  }
  function symbolOnlySVG(txt, idx){
    const palette = optsPalette ? optsPalette : pick(palettes); const col1 = palette[Math.floor(rngColor()*palette.length)]; const col2 = palette[(Math.floor(rngColor()*palette.length+1))%palette.length];
    const cx=480, cy=270, R=Math.floor(lerp(110,160,rngLayout())); const gap=Math.floor(lerp(10,26,rngLayout()));
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="100%" height="100%" fill="#0b0620"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="${col1}"/>
  <circle cx="${cx}" cy="${cy}" r="${R-gap}" fill="${col2}"/>
  <text x="${cx}" y="${cy+24}" text-anchor="middle" font-family="Inter" font-weight="900" font-size="96" fill="#0b0620">${initials[0]||'S'}</text></svg>`;
  }
  const make={'Wordmark':wordmarkSVG,'Monogram':monogramSVG,'Icon+Wordmark':iconWordmarkSVG,'Emblem':emblemSVG,'Symbol-only':symbolOnlySVG};
  const fn = make[style] || wordmarkSVG;
  const svgs=[fn(baseName,1),fn(baseName,2),fn(baseName,3)];
  const dir = path.join(STORAGE_DIR, `logos_${safe.toLowerCase().replace(/[^a-z0-9]+/g,'_')}`);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const st = String(style||'Wordmark').toLowerCase().replace(/[^a-z0-9]+/g,'_');
  const ts = Date.now(); const g=(typeof gen==='number'?gen:0);
  const files=[]; svgs.forEach((svg,i)=>{ const p=path.join(dir,`logo_${st}_g${g}_${ts}_${i+1}.svg`); fs.writeFileSync(p,svg,'utf-8'); files.push(p); });
  return files;
}


// Profile util
function buildProfileFromAnswers(m){ return {
  name: m['vision.name']||'Your Company', mission:m['vision.mission']||'', brand:m['vision.brand']||'',
  problem:m['problem.core']||'', customers:m['market.customer']||'',
  product:m['product.overview']||'', mvp:m['product.mvp']||'', revenue:m['revenue.model']||''
}; }

// Routes
app.get('/api/session',(req,res)=> res.json({sessionId:createSession(), total:TOTAL_QUESTIONS}));

app.get('/api/next-question',(req,res)=>{
  const s=getSession(req.query.sessionId); if(!s) return res.status(404).json({error:'Session not found'});
  const q=getCurrentQuestion(s); if(!q) return res.json({done:true,message:'Interview complete.'});
  let text=q.text; if(q.id==='vision.name') text += " (Tip: If you don't have a name yet, just say so. After your mission I'll generate tailored name ideas.)";
  res.json({ questionId:q.id, text, index:s.current_index, total:TOTAL_QUESTIONS });
});

app.post('/api/answer', async (req,res)=>{
  const {sessionId,text}=req.body; if(!sessionId || text===undefined) return res.status(400).json({error:'sessionId and text required'});
  const s=getSession(sessionId); if(!s) return res.status(404).json({error:'Session not found'});
  const q=getCurrentQuestion(s); if(!q) return res.json({done:true,message:'Interview complete.'});

  if(q.id==='vision.name'){
    const t=(text||'').toLowerCase();
    const none=t===''||/(^|\b)(no|not yet|don\'t|dont|open to suggestions|none|no name|haven\'t decided|havent decided|undecided|tbd|to be decided|no brand|brandless)(\b|$)/.test(t);
    if(none){ setPendingName(sessionId,true); saveAnswer(sessionId,q.id,text||'',"",0); advance(sessionId); const nextQ=getCurrentQuestion(getSession(sessionId)); return res.json({ mentor:"No problem. We'll generate name ideas after your mission.", needConfirm:false }); }
  }
  if(q.id==='vision.brand'){
    const t=(text||'').toLowerCase();
    const none=t===''||/(no logo|don\'t have|dont have|none|not yet|logo yok|no brand|haven\'t decided|undecided|tbd)/.test(t);
    if(none){ setPendingLogo(sessionId,true); saveAnswer(sessionId,q.id,text||'',"",0); return res.json({ mentor:"Pick a logo style to begin. I will generate 3 SVG options each time.", needConfirm:false, chooseLogo:true, styles:['Wordmark','Monogram','Icon+Wordmark','Emblem','Symbol-only'] }); }
  }

  const mentor=await chat([{role:'system',content:MENTOR_SYSTEM_PROMPT},{role:'user',content:`Current question: "${q.text}"\nUser answer: "${text||''}"\nRewrite concisely for investors, then add: "Confirm to save, or Edit to adjust."`}], 0.2);
  saveAnswer(sessionId,q.id,text||'',"",0);
  res.json({ mentor, needConfirm:true });
});

app.post('/api/confirm', async (req,res)=>{
  const {sessionId, refinedText}=req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'});
  const s=getSession(sessionId); if(!s) return res.status(404).json({error:'Session not found'});
  const q=getCurrentQuestion(s); if(!q) return res.json({done:true,message:'Interview complete.'});
  const row=db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId,q.id);
  if(!row) return res.status(400).json({error:'No pending answer for this question. Submit /api/answer first.'});
  db.prepare('UPDATE answers SET refined_value=?, confirmed=1 WHERE id=?').run(refinedText ?? row.raw_value, row.id);

  if(q.id==='vision.mission' && getPendingName(sessionId) && !hasConfirmedName(sessionId)){
    const mission=(refinedText ?? row.raw_value ?? ''); const avoid=getNameHistory(sessionId);
    const suggestions=await generateNames(mission, avoid); setNameSuggestions(sessionId,suggestions); addToNameHistory(sessionId,suggestions);
    return res.json({ chooseName:true, suggestions });
  }
  if(q.id==='vision.brand' && getPendingLogo(sessionId)){
    return res.json({ chooseLogo:true, message:"Pick a logo style to begin:", styles:['Wordmark','Monogram','Icon+Wordmark','Emblem','Symbol-only'] });
  }

  advance(sessionId);
  const nextQ=getCurrentQuestion(getSession(sessionId)); if(!nextQ) return res.json({done:true,message:'Interview complete.'});
  res.json({ nextQuestionId:nextQ.id, text:nextQ.text });
});

app.post('/api/select-name',(req,res)=>{
  const {sessionId,choice}=req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'});
  const s=getSession(sessionId); if(!s) return res.status(404).json({error:'Session not found'});
  const sugg=getNameSuggestions(sessionId); let chosen=''; if(typeof choice==='number') chosen=sugg[choice]||''; else if(typeof choice==='string'){ const i=sugg.findIndex(x=>x.toLowerCase()===choice.toLowerCase()); chosen=i>=0?sugg[i]:choice; }
  if(!chosen) return res.status(400).json({error:'Invalid choice'});
  const row=db.prepare('SELECT id FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId,'vision.name');
  if(row) db.prepare('UPDATE answers SET refined_value=?, confirmed=1 WHERE id=?').run(chosen,row.id); else saveAnswer(sessionId,'vision.name',chosen,chosen,1);
  addToNameHistory(sessionId,[chosen]); setPendingName(sessionId,false); setNameSuggestions(sessionId,[]);
  const q=getCurrentQuestion(s); if(q && q.id==='vision.mission') advance(sessionId);
  const nextQ=getCurrentQuestion(getSession(sessionId)); if(!nextQ) return res.json({done:true,message:'Interview complete.'}); res.json({ok:true,nextQuestionId:nextQ.id,text:nextQ.text});
});

app.post('/api/generate/name-ideas', async (req,res)=>{
  const {sessionId}=req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'});
  const row=db.prepare(`SELECT COALESCE(NULLIF(refined_value, ''), raw_value) AS v FROM answers WHERE session_id=? AND question_id=? AND confirmed=1 ORDER BY created_at DESC LIMIT 1`).get(sessionId,'vision.mission');
  const mission=row&&row.v?row.v:''; if(!mission) return res.status(400).json({error:'Mission is required before generating names.'});
  const avoid=getNameHistory(sessionId); const suggestions=await generateNames(mission, avoid); setNameSuggestions(sessionId,suggestions); addToNameHistory(sessionId,suggestions); res.json({suggestions});
});

app.post('/api/logo/style',(req,res)=>{
  const {sessionId, style}=req.body; if(!sessionId || !style) return res.status(400).json({error:'sessionId and style required'});
  setLogoStyle(sessionId, String(style)); res.json({ok:true});
});


app.post('/api/generate/logos',(req,res)=>{ const {sessionId, style:styleFromBody, keepLayout} = req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'});
  const row=db.prepare(`SELECT COALESCE(NULLIF(refined_value, ''), raw_value) AS v FROM answers WHERE session_id = ? AND question_id = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 1`).get(sessionId,'vision.name');
  const name=row&&row.v?row.v:'Your Company'; const prefs=getLogoPrefs(sessionId);
  const style=(styleFromBody || getLogoStyle(sessionId));
  let layoutSeed = prefs.layoutSeed || 0;
  if(keepLayout){ if(!layoutSeed){ layoutSeed = (Date.now()>>>0); setLayoutSeed(sessionId, layoutSeed); } setKeepLayout(sessionId,true); }
  else { setKeepLayout(sessionId,false); setLayoutSeed(sessionId, 0); }
  const gen = bumpLogoGen(sessionId);
  const opts = { paletteLock: prefs.lockPalette? (prefs.palette||null):null, fontLock: prefs.lockFont? (prefs.font||null):null, keepLayout: !!keepLayout, layoutSeed };
  const files=generateLogoSvgs(name, style, gen, opts);
  setLogoVariants(sessionId,files);
  return res.json({ files: files.map(f=>`/download?path=${encodeURIComponent(f)}&v=${Date.now()}_${Math.random().toString(36).slice(2,7)}`), style, gen, keepLayout: !!keepLayout });
});

app.post('/api/select-logo',(req,res)=>{
  const {sessionId,choice}=req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'});
  const variants=getLogoVariants(sessionId); if(!variants.length) return res.status(400).json({error:'No logo variants available. Generate first.'});
  let selected=''; if(typeof choice==='number') selected=variants[choice]||''; else if(typeof choice==='string'){ selected=variants.find(v=>v.endsWith(choice)||v===choice)||''; }
  if(!selected) return res.status(400).json({error:'Invalid choice'});
  const row=db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId,'vision.brand');
  const note=`Selected logo: ${selected}`; if(row){ const base=(row.refined_value&&row.refined_value.trim()!=='')?row.refined_value:(row.raw_value||''); const val=base? base+'\\n'+note : note; db.prepare('UPDATE answers SET refined_value=?, confirmed=1 WHERE id=?').run(val,row.id);} else { saveAnswer(sessionId,'vision.brand',note,note,1); }
  setPendingLogo(sessionId,false); setLogoVariants(sessionId,[]);
  const s=getSession(sessionId); const q=getCurrentQuestion(s); if(q && q.id==='vision.brand') advance(sessionId);
  const nextQ=getCurrentQuestion(getSession(sessionId)); if(!nextQ) return res.json({done:true,message:'Interview complete.'}); res.json({ok:true,nextQuestionId:nextQ.id,text:nextQ.text});
});

// Founder pack (minimal)
async function llm(text){ return chat([{role:'system',content:PACK_SYSTEM_PROMPT},{role:'user',content:text}],0.2); }
async function generateDeck(profile,out){ const slidesText=await llm(`Create a 10-slide pitch outline JSON: [{title, bullets:[...]}]. Keep bullets short. Profile: ${JSON.stringify(profile)}`); let slides=[]; try{slides=JSON.parse(slidesText); if(!Array.isArray(slides)) throw 0;}catch{slides=[{title:'Vision',bullets:[profile.mission||'']},{title:'Problem',bullets:[profile.problem||'']}];} const pptx=new PptxGenJS(); slides.forEach(s=>{const sl=pptx.addSlide(); sl.addText(s.title||'',{x:0.5,y:0.5,w:9,fontSize:28,bold:true}); sl.addText((s.bullets||[]).map(b=>`• ${b}`).join('\\n'),{x:0.7,y:1.3,w:9,fontSize:16});}); await pptx.writeFile({fileName:out}); return out; }
async function generateFounderPack(sessionId){
  const map=getAllConfirmedAnswers(sessionId); const profile=buildProfileFromAnswers(map); const date=dayjs().format('YYYYMMDD_HHmm');
  const safe=(profile.name||'company').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const deck=path.join(STORAGE_DIR,`deck_${safe}_${date}.pptx`), pdf=path.join(STORAGE_DIR,`founder-pack_${safe}_${date}.pdf`), logosZip=path.join(STORAGE_DIR,`logos_${safe}.zip`), logosDir=path.join(STORAGE_DIR,`logos_${safe}`), profileJson=path.join(STORAGE_DIR,`profile_${safe}_${date}.json`);
  await generateDeck(profile,deck);
  if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir,{recursive:true});
  const liveDir=path.join(STORAGE_DIR, `logos_live_${safe}`); if (fs.existsSync(liveDir)) { for (const f of fs.readdirSync(liveDir)) fs.copyFileSync(path.join(liveDir,f), path.join(logosDir,f)); }
  fs.writeFileSync(profileJson, JSON.stringify(profile,null,2), 'utf-8');
  await new Promise((resolve,reject)=>{ const doc=new PDFDocument({size:'A4',margins:{top:50,bottom:50,left:60,right:60}}); const s=fs.createWriteStream(pdf); doc.pipe(s); doc.fontSize(22).text(profile.name||'Startup Orchestra Founder Pack',{underline:true}); doc.moveDown(0.5); doc.fontSize(12).fillColor('#666').text(`Generated ${dayjs().format('YYYY-MM-DD HH:mm')}`); doc.fillColor('black'); doc.moveDown(1); doc.fontSize(14).text('Mission'); doc.fontSize(12).text(profile.mission||''); doc.addPage(); doc.fontSize(14).text('Problem'); doc.fontSize(12).text(profile.problem||''); doc.addPage(); doc.fontSize(14).text('Product'); doc.fontSize(12).text(profile.product||''); doc.end(); s.on('finish',resolve); s.on('error',reject); });
  await new Promise((resolve,reject)=>{ const out=fs.createWriteStream(logosZip); const ar=archiver('zip',{zlib:{level:9}}); out.on('close',resolve); ar.on('error',reject); ar.pipe(out); if (fs.existsSync(logosDir)) { for(const f of fs.readdirSync(logosDir)){ ar.file(path.join(logosDir,f),{name:f}); } } ar.finalize(); });
  return { pdfPath:pdf, deckPath:deck, logosZip:logosZip, profileJsonPath:profileJson };
}
app.post('/api/generate/founder-pack', async (req,res)=>{
  try{ const {sessionId}=req.body; if(!sessionId) return res.status(400).json({error:'sessionId required'}); const r=await generateFounderPack(sessionId);
    res.json({ ok:true, downloads:{ founderPackPdf:`/download?path=${encodeURIComponent(r.pdfPath)}`, deckPptx:`/download?path=${encodeURIComponent(r.deckPath)}`, logosZip:`/download?path=${encodeURIComponent(r.logosZip)}`, profileJson:`/download?path=${encodeURIComponent(r.profileJsonPath)}` } });
  } catch(e){ console.error(e); res.status(500).json({error:'Failed to generate Founder Pack'}); }
});


// List latest answers per question for this session (for the "My Answers" modal)
app.get('/api/answers', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const out = [];
  for (let i = 0; i < FLAT_QUESTIONS.length; i++) {
    const q = FLAT_QUESTIONS[i];
    const row = db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId, q.id);
    const value = row ? ((row.refined_value && row.refined_value.trim() !== '') ? row.refined_value : (row.raw_value || '')) : '';
    out.push({
      index: i + 1,
      question_id: q.id,
      question_text: q.text,
      confirmed: !!(row && row.confirmed),
      raw: row ? (row.raw_value || '') : '',
      refined: row ? (row.refined_value || '') : '',
      value
    });
  }
  const confirmedCount = out.filter(x => x.confirmed).length;
  res.json({ total: FLAT_QUESTIONS.length, confirmed: confirmedCount, items: out });
});


// Jump to a specific question for editing
app.post('/api/jump-to', (req, res) => {
  const { sessionId, questionId } = req.body || {};
  if (!sessionId || !questionId) return res.status(400).json({ error: 'sessionId and questionId required' });
  const idx = FLAT_QUESTIONS.findIndex(q => q.id === questionId);
  if (idx < 0) return res.status(400).json({ error: 'Unknown questionId' });
  db.prepare('UPDATE sessions SET current_index=? WHERE id=?').run(idx, sessionId);
  const q = FLAT_QUESTIONS[idx];
  const row = db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId, questionId);
  const lastValue = row ? ((row.refined_value && row.refined_value.trim() !== '') ? row.refined_value : (row.raw_value || '')) : '';
  return res.json({ ok: true, question: { id: q.id, text: q.text, index: idx, total: TOTAL_QUESTIONS }, lastValue });
});


app.get('/api/export/answers.json', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const items = [];
  for (let i = 0; i < FLAT_QUESTIONS.length; i++) {
    const q = FLAT_QUESTIONS[i];
    const row = db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId, q.id);
    items.push({
      index: i + 1, id: q.id, question: q.text,
      raw: row ? (row.raw_value || '') : '',
      refined: row ? (row.refined_value || '') : '',
      confirmed: !!(row && row.confirmed)
    });
  }
  const profile = buildProfileFromAnswers(getAllConfirmedAnswers(sessionId));
  const payload = { sessionId, total: FLAT_QUESTIONS.length, generatedAt: new Date().toISOString(), profile, items };
  const safe = (profile.name || 'answers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'');
  const file = path.join(STORAGE_DIR, `answers_${safe}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  res.json({ ok: true, download: `/download?path=${encodeURIComponent(file)}` });
});


app.get('/api/export/answers.pdf', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const profile = buildProfileFromAnswers(getAllConfirmedAnswers(sessionId));
  const safe = (profile.name || 'answers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g,'');
  const file = path.join(STORAGE_DIR, `answers_${safe}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 60, right: 60 } });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);
  doc.fontSize(22).text(`${profile.name || 'Startup'} — Answers Summary`, { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#666').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1).fillColor('black');
  for (let i = 0; i < FLAT_QUESTIONS.length; i++) {
    const q = FLAT_QUESTIONS[i];
    const row = db.prepare('SELECT * FROM answers WHERE session_id=? AND question_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId, q.id);
    const val = row ? ((row.refined_value && row.refined_value.trim() !== '') ? row.refined_value : (row.raw_value || '')) : '';
    doc.fontSize(13).text(`Q${i+1}. ${q.text}`, { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(11).text(val || '—', { continued: false });
    doc.moveDown(0.6);
    if (doc.y > 760) doc.addPage();
  }
  doc.end();
  stream.on('finish', () => res.json({ ok: true, download: `/download?path=${encodeURIComponent(file)}` }));
  stream.on('error', () => res.status(500).json({ error: 'Failed to generate PDF' }));
});


// Skip current question (no save), advance to next
app.post('/api/skip', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const s = getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.current_index >= TOTAL_QUESTIONS) return res.json({ done: true, message: 'Interview complete.' });
  advance(sessionId);
  const s2 = getSession(sessionId);
  const nextQ = getCurrentQuestion(s2);
  if (!nextQ) return res.json({ done: true, message: 'Interview complete.' });
  return res.json({ ok: true, nextQuestionId: nextQ.id, text: nextQ.text, index: s2.current_index, total: TOTAL_QUESTIONS });
});


// Save logo palette/font preferences
app.post('/api/logo-prefs', (req,res)=>{
  const { sessionId, palette, font, lockPalette, lockFont } = req.body || {};
  if(!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try{
    setLogoPrefs(sessionId, {palette, font, lockPalette, lockFont});
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:'Failed to save prefs' }); }
});

// Favorites toggle
app.post('/api/favorites/toggle', (req,res)=>{
  const { sessionId, path: p, style } = req.body || {};
  if(!sessionId || !p) return res.status(400).json({ error:'sessionId and path required' });
  const exist = db.prepare('SELECT 1 FROM favorites WHERE session_id=? AND path=?').get(sessionId, p);
  if(exist){
    db.prepare('DELETE FROM favorites WHERE session_id=? AND path=?').run(sessionId, p);
    return res.json({ ok:true, favored:false });
  }else{
    db.prepare('INSERT INTO favorites(session_id, path, style, created_at) VALUES(?,?,?,?)').run(sessionId, p, style||'', Date.now());
    return res.json({ ok:true, favored:true });
  }
});
app.get('/api/favorites', (req,res)=>{
  const sessionId = req.query.sessionId;
  if(!sessionId) return res.status(400).json({ error:'sessionId required'});
  const rows = db.prepare('SELECT * FROM favorites WHERE session_id=? ORDER BY created_at DESC').all(sessionId);
  res.json({ items: rows });
});

// Export ZIP: source=current|favorites
app.post('/api/export/zip', async (req,res)=>{
  const { sessionId, source } = req.body || {};
  if(!sessionId) return res.status(400).json({ error:'sessionId required' });
  const files = [];
  if(source==='favorites'){
    const rows = db.prepare('SELECT path FROM favorites WHERE session_id=? ORDER BY created_at DESC').all(sessionId);
    rows.forEach(r=>{ if(r.path && fs.existsSync(r.path)) files.push(r.path); });
  }else{
    // current = last generated logos in session
    const f = getLogoVariants(sessionId);
    f.forEach(p=>{ if(p && fs.existsSync(p)) files.push(p); });
  }
  if(!files.length) return res.status(400).json({ error:'No files to export' });
  const safeBase = 'logos_'+(Date.now());
  const zipFile = path.join(STORAGE_DIR, `${safeBase}.zip`);
  const output = fs.createWriteStream(zipFile);
  const archive = archiver('zip',{ zlib:{level:9} });
  archive.pipe(output);
  files.forEach(fp=>{
    const name = path.basename(fp);
    archive.file(fp, { name });
  });
  await archive.finalize();
  output.on('close', ()=> res.json({ ok:true, download:`/download?path=${encodeURIComponent(zipFile)}&v=${Date.now()}` }));
  output.on('error', ()=> res.status(500).json({ error:'ZIP failed' }));
});

// Generate mini previews (one per style)
app.post('/api/generate/previews', (req,res)=>{
  const { sessionId } = req.body || {};
  if(!sessionId) return res.status(400).json({ error:'sessionId required' });
  const row=db.prepare(`SELECT COALESCE(NULLIF(refined_value, ''), raw_value) AS v FROM answers WHERE session_id = ? AND question_id = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 1`).get(sessionId,'vision.name');
  const name=row&&row.v?row.v:'Your Company';
  const styles=['Wordmark','Monogram','Icon+Wordmark','Emblem','Symbol-only'];
  const gen = bumpLogoGen(sessionId);
  const prefs = getLogoPrefs(sessionId);
  const files = [];
  styles.forEach((st)=>{
    const opts = { paletteLock: prefs.lockPalette? (prefs.palette||null):null, fontLock: prefs.lockFont? (prefs.font||null):null, keepLayout:false };
    const fsx = generateLogoSvgs(name, st, gen, opts);
    // keep only the first variant for preview
    files.push({ style: st, url: `/download?path=${encodeURIComponent(fsx[0])}&v=${Date.now()}_${Math.random().toString(36).slice(2,7)}` });
  });
  setLogoStyle(sessionId, ''); // clear selected style until user clicks
  res.json({ items: files });
});

// Robust download route
app.get('/download', (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).send('path required');
  const filePath = path.resolve(String(raw));
  const baseDir = path.resolve(STORAGE_DIR);
  if (!filePath.startsWith(baseDir + path.sep)) return res.status(403).send('forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  return res.sendFile(filePath);
});

app.get('*',(req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Startup Orchestra MVP running at http://localhost:${PORT} (storage: ${STORAGE_DIR})`));
