(function(){
'use strict';

/* ================= 常量 ================= */
const INTERVAL_MS = {'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1d':86400000};
const FIB_LEVELS = [0,0.236,0.382,0.5,0.618,0.786,1];
const UP = '#0c9a6c', DOWN = '#e5484d', ACCENT = '#1e6fff';
const SETTINGS_KEY = 'btcReplay.settings.v1';
const SESSIONS_KEY = 'btcReplay.sessions.v1';
const MAX_SESSIONS = 200;

/* ================= 状态 ================= */
const state = {
  symbol:'BTCUSDT', interval:'15m',
  rangeStart:null, rangeEnd:null, contextBars:100, dataSource:'bundle',
  anchor:null, currentTime:null,
  candles:[], playing:false, timer:null,
  position:null, pendingDir:null, trades:[],
  drawMode:'none', drawings:[], drawTempPoint:null,
  sessionId:null, sessionNote:'', reportShown:false, mode:'replay'
};
const el = id => document.getElementById(id);

/* ================= 工具函数 ================= */
function fmtTime(ms){
  const d = new Date(ms), p = n => String(n).padStart(2,'0');
  return `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtFull(ms){
  const d = new Date(ms), p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtPrice(v){ if(v==null || isNaN(v)) return '--'; return v>=100 ? v.toFixed(2) : v.toFixed(4); }
function fmtPct(v){ return (v>=0?'+':'')+v.toFixed(2)+'%'; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function reasonText(r){
  return r==='tp'?'止盈':r==='sl'?'止损':r==='report'?'结算':'手动平仓';
}

let toastTimer = null;
function toast(msg, type){
  const t = el('status-toast');
  t.textContent = msg; t.className = 'show ' + (type||'');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.className=''; }, 2600);
}

function openSheet(sheetId, backdropId){ el(sheetId).classList.add('show'); el(backdropId).classList.add('show'); }
function closeSheet(sheetId, backdropId){ el(sheetId).classList.remove('show'); el(backdropId).classList.remove('show'); }

/* ================= 本地存储 ================= */
function loadSessions(){
  try{ return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || []; }catch(e){ return []; }
}
function saveSessions(list){
  try{ localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); }catch(e){ toast('存储空间不足，历史记录可能无法保存','error'); }
}
function loadSettings(){
  try{ return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }catch(e){ return {}; }
}
function saveSettings(){
  try{
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      symbol:state.symbol, rangeStart:el('rangeStart').value, rangeEnd:el('rangeEnd').value,
      contextBars:state.contextBars, dataSource:state.dataSource
    }));
  }catch(e){}
}

function newSessionId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function beginSession(keepId, note){
  state.sessionId = keepId || newSessionId();
  state.sessionNote = note || '';
  state.reportShown = false;
  state.trades = [];
  state.position = null;
}
function upsertSession(patch){
  const sessions = loadSessions();
  const i = sessions.findIndex(s => s.id === state.sessionId);
  const base = i >= 0 ? sessions[i] : {id:state.sessionId, createdAt:Date.now()};
  const rec = Object.assign({}, base, patch, {id:state.sessionId, updatedAt:Date.now()});
  if(i >= 0) sessions[i] = rec; else sessions.unshift(rec);
  if(sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
  saveSessions(sessions);
  return rec;
}

/* ================= 本地数据包 ================= */
const BUNDLE_INTERVALS = ['5m','1h','1d'];
let bundleMeta = null;
const bundleCache = {};

async function loadBundleFile(file){
  if(bundleCache[file]) return bundleCache[file];
  if(typeof DecompressionStream === 'undefined'){
    throw new Error('浏览器不支持数据解压，请更新夸克浏览器或改用 Chrome');
  }
  const res = await fetch(file);
  if(!res.ok) throw new Error(`本地数据文件加载失败 (${res.status})`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const candles = [];
  for(const line of text.split('\n')){
    if(!line) continue;
    const p = line.split(',');
    candles.push({time:+p[0], open:+p[1], high:+p[2], low:+p[3], close:+p[4], volume:+p[5]});
  }
  bundleCache[file] = candles;
  return candles;
}

async function initBundleMeta(){
  try{
    const res = await fetch('data/meta.json');
    if(res.ok) bundleMeta = await res.json();
  }catch(e){ bundleMeta = null; }
}

function bundlePackBounds(){
  if(!bundleMeta) return null;
  let start = Infinity, end = 0;
  for(const k in bundleMeta.files){
    const f = bundleMeta.files[k];
    if(f.start < start) start = f.start;
    if(f.end > end) end = f.end;
  }
  return (start === Infinity) ? null : {start, end};
}

function updateTfAvailability(){
  const bundle = state.dataSource === 'bundle';
  document.querySelectorAll('.tf-chip').forEach(b=>{
    b.classList.toggle('disabled', bundle && !BUNDLE_INTERVALS.includes(b.dataset.tf));
  });
}

/* ================= 数据获取 ================= */
function hashSeed(str){
  let h = 2166136261 >>> 0;
  for(let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generateDemoCandles(symbol, interval, startMs, endMs){
  const step = INTERVAL_MS[interval];
  const totalBars = Math.floor((endMs - startMs)/step);
  let genEnd = endMs;
  if(totalBars > 4000) genEnd = startMs + 4000*step;
  const base = ({BTCUSDT:60000, ETHUSDT:3200, SOLUSDT:150, BNBUSDT:600}[symbol]) || 60000;
  const rnd = mulberry32(hashSeed(symbol + '_' + interval + '_' + startMs));
  const volScale = Math.sqrt(step/900000);
  let drift = 0, nextChange = 1, price = base*(0.85 + rnd()*0.3);
  const out = [];
  for(let t = startMs; t < genEnd; t += step){
    nextChange--;
    if(nextChange <= 0){
      drift = (rnd() - 0.5)*0.004*volScale;
      nextChange = 20 + Math.floor(rnd()*120);
    }
    const noise = (rnd() - 0.5)*0.006*volScale;
    const open = price;
    const close = Math.max(base*0.2, open*Math.exp(drift + noise));
    const wick = Math.abs(noise)*0.5 + 0.0015*volScale;
    const high = Math.max(open, close)*(1 + rnd()*wick);
    const low = Math.min(open, close)*(1 - rnd()*wick);
    const volume = 20 + rnd()*rnd()*120;
    out.push({time:Math.floor(t/1000), open, high, low, close, volume});
    price = close;
  }
  return out;
}

async function getData(symbol, interval, startMs, endMs){
  if(state.dataSource === 'demo'){
    const candles = generateDemoCandles(symbol, interval, startMs, endMs);
    return candles.filter(c => c.time*1000 >= startMs && c.time*1000 <= endMs);
  }
  const key = symbol + '_' + interval;
  const info = bundleMeta && bundleMeta.files[key];
  if(!info) throw new Error(`${symbol} 暂无「${interval}」本地数据包（可用 5m/1h/1d）`);
  const start = Math.max(startMs, info.start);
  const end = Math.min(endMs, info.end);
  if(start >= end) return [];
  const years = Object.keys(info.years).map(Number).filter(y=>{
    const f = info.years[y];
    return f.end >= start && f.start <= end;
  }).sort((a,b)=>a-b);
  if(!years.length) return [];
  const parts = [];
  for(const y of years){
    parts.push(await loadBundleFile(info.years[y].file));
  }
  const out = [];
  for(const part of parts){
    for(const c of part){
      if(c.time*1000 >= start && c.time*1000 <= end) out.push(c);
    }
  }
  out.sort((a,b)=>a.time-b.time);
  return out;
}

/* ================= 图表 ================= */
if(typeof LightweightCharts === 'undefined'){
  const es = el('emptyState');
  const icon = es.querySelector('.empty-icon');
  const p = es.querySelector('p');
  const btn = es.querySelector('button');
  if(icon) icon.textContent = '⚠️';
  if(p) p.innerHTML = '图表组件加载失败<br>请检查网络后刷新重试';
  if(btn) btn.style.display = 'none';
  throw new Error('lightweight-charts script not loaded');
}
const chart = LightweightCharts.createChart(el('chart-container'), {
  layout:{ background:{color:'transparent'}, textColor:'#5c6b82', fontFamily:'-apple-system, PingFang SC, Microsoft YaHei, sans-serif', fontSize:11 },
  grid:{ vertLines:{color:'rgba(30,60,100,0.045)'}, horzLines:{color:'rgba(30,60,100,0.045)'} },
  crosshair:{ mode: LightweightCharts.CrosshairMode.Normal,
    vertLine:{color:'#9fb8dd', labelBackgroundColor:ACCENT},
    horzLine:{color:'#9fb8dd', labelBackgroundColor:ACCENT} },
  rightPriceScale:{ borderColor:'#e3e9f1' },
  timeScale:{ borderColor:'#e3e9f1', timeVisible:true, secondsVisible:false },
  handleScroll:true, handleScale:true
});
const candleSeries = chart.addCandlestickSeries({
  upColor:UP, downColor:DOWN, borderVisible:false,
  wickUpColor:UP, wickDownColor:DOWN
});
const volChart = LightweightCharts.createChart(el('vol-container'), {
  layout:{ background:{color:'transparent'}, textColor:'#93a1b4', fontFamily:'-apple-system, PingFang SC, Microsoft YaHei, sans-serif', fontSize:9 },
  grid:{ vertLines:{visible:false}, horzLines:{visible:false} },
  rightPriceScale:{ borderColor:'#e3e9f1' },
  timeScale:{ borderColor:'#e3e9f1', visible:false },
  handleScroll:false, handleScale:false
});
const volSeries = volChart.addHistogramSeries({ priceFormat:{type:'volume'}, color:UP });
chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
  if(range) volChart.timeScale().setVisibleLogicalRange(range);
});

function resizeCharts(){
  const cw = el('chart-container').clientWidth, ch = el('chart-container').clientHeight;
  chart.applyOptions({width:cw, height:ch});
  volChart.applyOptions({width:el('vol-container').clientWidth, height:el('vol-container').clientHeight});
  resizeOverlay();
  if(state.candles.length){
    chart.timeScale().fitContent();
    renderOverlay();
  }
}
new ResizeObserver(resizeCharts).observe(el('chart-container'));
window.addEventListener('resize', resizeCharts);
window.addEventListener('orientationchange', ()=>setTimeout(resizeCharts, 200));

/* ================= 复盘核心 ================= */
async function startNewRound(){
  stopPlay();
  if(state.dataSource === 'bundle' && !bundleMeta) await initBundleMeta();
  state.mode = 'replay';
  el('browseRow').style.display = 'none';
  el('playRow').style.display = 'flex';
  el('revealRow').style.display = 'flex';
  el('progressStrip').style.display = '';
  el('browseToggleBtn').classList.remove('active');
  const symbol = el('symbol').value;
  let rs = new Date(el('rangeStart').value + 'T00:00:00Z').getTime();
  let re = new Date(el('rangeEnd').value + 'T23:59:59Z').getTime();
  const contextBars = Math.max(20, Math.min(300, parseInt(el('contextBars').value) || 100));
  if(state.dataSource === 'bundle' && bundleMeta){
    const bounds = bundlePackBounds();
    if(bounds){
      if(rs < bounds.start) rs = bounds.start;
      if(re > bounds.end) re = bounds.end;
      el('rangeStart').value = new Date(rs).toISOString().slice(0,10);
      el('rangeEnd').value = new Date(re).toISOString().slice(0,10);
    }
  }
  if(!rs || !re || re <= rs){ toast('请检查时间范围是否正确（是否超出本地数据包范围）','error'); return; }

  const intervalMs = INTERVAL_MS[state.interval];
  let minAnchor = rs + contextBars*intervalMs;
  let maxAnchor = re - intervalMs*5;
  if(maxAnchor <= minAnchor){ minAnchor = rs; maxAnchor = re; }
  let anchor = minAnchor + Math.random()*(maxAnchor - minAnchor);
  anchor = Math.floor(anchor/intervalMs)*intervalMs;

  state.symbol = symbol;
  state.rangeStart = rs; state.rangeEnd = re; state.contextBars = contextBars;
  state.anchor = anchor; state.currentTime = anchor;
  beginSession();
  state.drawings = []; state.drawTempPoint = null;
  setDrawMode('none'); el('drawToolbar').style.display = 'none'; el('drawToggleBtn').classList.remove('active');
  saveSettings();

  toast('正在拉取行情数据…','');
  el('drawBtn').disabled = true;
  try{
    await loadAndRender();
    el('emptyState').style.display = 'none';
    el('hudMini').style.display = 'flex';
    refreshMarkers(); updateTradeButtons();
    toast(`新片段已就绪 · ${fmtTime(state.currentTime)}`, 'ok');
    closeSheet('settingsSheet','settingsBackdrop');
  }catch(err){
    toast(err.message || String(err), 'error');
  }finally{
    el('drawBtn').disabled = false;
  }
}

async function loadAndRender(){
  const intervalMs = INTERVAL_MS[state.interval];
  const startMs = state.anchor - state.contextBars*intervalMs;
  const candles = await getData(state.symbol, state.interval, startMs, state.rangeEnd);
  if(!candles.length) throw new Error('该区间没有可用数据，请调整时间范围或周期');
  state.candles = candles;
  renderChart();
}

/* ================= 直接看盘模式 ================= */
function enterBrowseMode(){
  if(state.mode === 'browse') return;
  state.mode = 'browse';
  stopPlay();
  el('tradeRow').style.display = 'none';
  el('pnlRow').style.display = 'none';
  el('playRow').style.display = 'none';
  el('revealRow').style.display = 'none';
  el('progressStrip').style.display = 'none';
  el('browseRow').style.display = 'flex';
  el('browseToggleBtn').classList.add('active');
  closeSheet('settingsSheet','settingsBackdrop');
  toast('直接看盘：选好周期后点「加载」','');
}
function backToReplay(){
  if(state.mode !== 'browse') return;
  state.mode = 'replay';
  stopPlay();
  el('browseRow').style.display = 'none';
  el('playRow').style.display = 'flex';
  el('revealRow').style.display = 'flex';
  el('progressStrip').style.display = '';
  el('browseToggleBtn').classList.remove('active');
  state.candles = [];
  state.anchor = null;
  state.trades = [];
  state.position = null;
  candleSeries.setData([]);
  volSeries.setData([]);
  candleSeries.setMarkers([]);
  el('emptyState').style.display = 'flex';
  el('hudMini').style.display = 'none';
  el('progressFill').style.width = '0%';
  el('progressText').textContent = '';
  updateTradeButtons();
}
async function browseLoad(){
  if(state.mode !== 'browse') return;
  if(state.dataSource === 'bundle' && !bundleMeta) await initBundleMeta();
  stopPlay();
  const symbol = el('symbol').value;
  const period = el('browsePeriod').value;
  const interval = state.interval;
  const step = INTERVAL_MS[interval];
  const now = Date.now();
  let start;
  if(period === '1y') start = now - 365*86400000;
  else if(period === '3y') start = now - 3*365*86400000;
  else if(period === '5y') start = now - 5*365*86400000;
  else start = 0;
  const totalBars = Math.ceil((now - start)/step);
  if(totalBars > 120000){
    toast(`数据量过大（约 ${Math.round(totalBars/1000)}k 根），请换 1h/4h/1d 周期或缩短范围`,'error');
    return;
  }
  state.symbol = symbol;
  state.rangeStart = start;
  state.rangeEnd = now;
  toast('正在加载历史数据…','');
  try{
    const candles = await getData(symbol, interval, start, now);
    if(!candles.length) throw new Error('该区间没有可用数据');
    state.candles = candles;
    state.currentTime = candles[candles.length-1].time*1000;
    state.trades = [];
    state.position = null;
    refreshMarkers();
    el('emptyState').style.display = 'none';
    el('hudMini').style.display = 'flex';
    renderChart();
    toast(`已加载 ${candles.length.toLocaleString()} 根 · ${interval} · 可直接缩放拖动`, 'ok');
  }catch(err){
    toast(err.message || String(err), 'error');
  }
}

function visibleCandles(){ return state.candles.filter(c => c.time*1000 <= state.currentTime); }

function renderChart(){
  const visible = visibleCandles();
  candleSeries.setData(visible);
  volSeries.setData(visible.map(c=>({
    time:c.time, value:c.volume,
    color:c.close >= c.open ? 'rgba(12,154,108,0.55)' : 'rgba(229,72,77,0.55)'
  })));
  chart.timeScale().fitContent();
  updateHud(visible);
  updateProgress(visible.length, state.candles.length);
  updatePositionPnl(visible[visible.length-1]);
}

function updateHud(visible){
  if(!visible.length) return;
  const last = visible[visible.length-1], first = visible[0];
  const chg = (last.close - first.open)/first.open*100;
  const chgLabel = state.mode === 'browse' ? '区间' : '本轮';
  el('hudMini').innerHTML =
    `<span class="hud-time">${fmtTime(last.time*1000)}</span>` +
    `<span>O<b>${fmtPrice(last.open)}</b></span>` +
    `<span>H<b>${fmtPrice(last.high)}</b></span>` +
    `<span>L<b>${fmtPrice(last.low)}</b></span>` +
    `<span>C<b class="${last.close>=last.open?'up':'down'}">${fmtPrice(last.close)}</b></span>` +
    `<span class="hud-chg ${chg>=0?'up':'down'}">${chgLabel} ${fmtPct(chg)}</span>`;
}
function updateProgress(revealed, total){
  const pct = total ? Math.round(revealed/total*100) : 0;
  el('progressFill').style.width = pct + '%';
  el('progressText').textContent = `${revealed} / ${total} 根 · ${pct}%`;
}

function stepForward(n=1){
  const intervalMs = INTERVAL_MS[state.interval];
  state.currentTime = Math.min(state.currentTime + intervalMs*n, state.rangeEnd);
  renderChart();
  const vis = visibleCandles();
  const last = vis[vis.length-1];
  if(last) checkTPSL(last);
  const allLast = state.candles[state.candles.length-1];
  if(allLast && state.currentTime >= allLast.time*1000){
    stopPlay();
    maybeShowReport();
  }
}
function stepBackward(){
  const intervalMs = INTERVAL_MS[state.interval];
  const floor = state.candles.length ? state.candles[0].time*1000 : state.currentTime;
  state.currentTime = Math.max(state.currentTime - intervalMs, floor);
  renderChart();
}
function revealAll(){
  stopPlay();
  const last = state.candles[state.candles.length-1];
  state.currentTime = last ? last.time*1000 : state.rangeEnd;
  renderChart();
  maybeShowReport();
}
function play(){
  if(state.playing || !state.candles.length) return;
  state.playing = true;
  el('playBtn').textContent = '⏸ 暂停';
  state.timer = setInterval(()=>stepForward(1), parseInt(el('speedSel').value));
}
function stopPlay(){
  state.playing = false;
  el('playBtn').textContent = '▶ 播放';
  if(state.timer){ clearInterval(state.timer); state.timer = null; }
}
function togglePlay(){ state.playing ? stopPlay() : play(); }

async function switchInterval(newInterval){
  if(newInterval === state.interval) return;
  state.interval = newInterval;
  if(state.mode === 'browse'){ browseLoad(); return; }
  if(!state.anchor) return;
  stopPlay();
  state.reportShown = false;
  toast('切换周期中…','');
  try{
    await loadAndRender();
    refreshMarkers();
    toast(`已切换至 ${newInterval}`, 'ok');
  }catch(err){
    toast(err.message || String(err), 'error');
  }
}

/* ================= 交易模拟 ================= */
function nearestBarTime(ms){
  if(!state.candles.length) return Math.floor(ms/1000);
  const t = ms/1000;
  let best = state.candles[0].time, bd = Math.abs(best - t);
  for(const c of state.candles){
    const d = Math.abs(c.time - t);
    if(d < bd){ bd = d; best = c.time; }
  }
  return best;
}
function lastVisibleCandle(){
  const vis = visibleCandles();
  return vis[vis.length-1] || null;
}

function openPositionSheet(direction){
  if(!state.candles.length){ toast('请先随机抽取一段行情','error'); return; }
  if(state.position){ toast('已有持仓，请先平仓','error'); return; }
  state.pendingDir = direction;
  el('tradeSheetTitle').textContent = direction === 'long' ? '开多 ▲' : '开空 ▼';
  el('tpInput').value = ''; el('slInput').value = '';
  ['tpChips','slChips'].forEach(rowId=>{
    el(rowId).querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c.dataset.val === ''));
  });
  openSheet('tradeSheet','tradeBackdrop');
}
function bindChips(rowId, inputId){
  const row = el(rowId), input = el(inputId);
  row.addEventListener('click', e=>{
    const chip = e.target.closest('.chip');
    if(!chip) return;
    row.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c === chip));
    input.value = chip.dataset.val;
  });
  input.addEventListener('input', ()=>{
    const v = parseFloat(input.value);
    row.querySelectorAll('.chip').forEach(c=>{
      const cv = c.dataset.val;
      c.classList.toggle('active', (cv === '' && input.value === '') || (cv !== '' && parseFloat(cv) === v));
    });
  });
}

function confirmOpen(){
  if(state.position) return;
  const tpRaw = parseFloat(el('tpInput').value), slRaw = parseFloat(el('slInput').value);
  const tp = isNaN(tpRaw) ? null : tpRaw;
  const sl = isNaN(slRaw) ? null : slRaw;
  if(tp != null && tp <= 0){ toast('止盈需大于 0','error'); return; }
  if(sl != null && sl <= 0){ toast('止损需大于 0','error'); return; }
  const last = lastVisibleCandle();
  if(!last) return;
  const dir = state.pendingDir;
  const pos = {direction:dir, entryPrice:last.close, entryTime:state.currentTime};
  if(tp != null){
    pos.tpPct = tp;
    pos.tpPrice = dir === 'long' ? last.close*(1 + tp/100) : last.close*(1 - tp/100);
  }
  if(sl != null){
    pos.slPct = sl;
    pos.slPrice = dir === 'long' ? last.close*(1 - sl/100) : last.close*(1 + sl/100);
  }
  state.position = pos;
  closeSheet('tradeSheet','tradeBackdrop');
  refreshMarkers(); updateTradeButtons(); updatePositionPnl(last);
  let msg = `${dir === 'long' ? '开多' : '开空'} @ ${fmtPrice(last.close)}`;
  if(tp != null || sl != null){
    msg += `（${tp != null ? '止盈'+tp+'%' : ''}${tp != null && sl != null ? ' / ' : ''}${sl != null ? '止损'+sl+'%' : ''}）`;
  }
  toast(msg, 'ok');
}

function checkTPSL(candle){
  const p = state.position;
  if(!p) return;
  let exitPrice = null, reason = null;
  if(p.direction === 'long'){
    const hitSl = p.slPrice != null && candle.low <= p.slPrice;
    const hitTp = p.tpPrice != null && candle.high >= p.tpPrice;
    if(hitSl && hitTp){
      const dSl = Math.abs(candle.open - p.slPrice), dTp = Math.abs(candle.open - p.tpPrice);
      if(dSl <= dTp){ exitPrice = p.slPrice; reason = 'sl'; } else { exitPrice = p.tpPrice; reason = 'tp'; }
    }else if(hitSl){ exitPrice = p.slPrice; reason = 'sl'; }
    else if(hitTp){ exitPrice = p.tpPrice; reason = 'tp'; }
  }else{
    const hitTp = p.tpPrice != null && candle.low <= p.tpPrice;
    const hitSl = p.slPrice != null && candle.high >= p.slPrice;
    if(hitTp && hitSl){
      const dTp = Math.abs(candle.open - p.tpPrice), dSl = Math.abs(candle.open - p.slPrice);
      if(dTp <= dSl){ exitPrice = p.tpPrice; reason = 'tp'; } else { exitPrice = p.slPrice; reason = 'sl'; }
    }else if(hitTp){ exitPrice = p.tpPrice; reason = 'tp'; }
    else if(hitSl){ exitPrice = p.slPrice; reason = 'sl'; }
  }
  if(reason) settlePosition(exitPrice, reason, candle.time*1000);
}

function settlePosition(exitPrice, reason, exitTime){
  const p = state.position;
  if(!p) return;
  const dir = p.direction;
  const pnlPct = dir === 'long'
    ? (exitPrice - p.entryPrice)/p.entryPrice*100
    : (p.entryPrice - exitPrice)/p.entryPrice*100;
  state.trades.push({
    direction:dir, entryPrice:p.entryPrice, entryTime:p.entryTime,
    exitPrice, exitTime, pnlPct, reason
  });
  state.position = null;
  refreshMarkers(); updateTradeButtons();
  toast(`${reasonText(reason)} ${fmtPct(pnlPct)}`, pnlPct >= 0 ? 'ok' : 'error');
}

function updatePositionPnl(lastCandle){
  if(!state.position || !lastCandle) return;
  const {direction, entryPrice} = state.position;
  const pnl = direction === 'long'
    ? (lastCandle.close - entryPrice)/entryPrice*100
    : (entryPrice - lastCandle.close)/entryPrice*100;
  el('posTag').textContent = direction === 'long' ? '多' : '空';
  el('posTag').className = 'pos-tag ' + direction;
  const pv = el('pnlVal');
  pv.textContent = fmtPct(pnl);
  pv.style.color = pnl >= 0 ? 'var(--up)' : 'var(--down)';
  const tp = state.position.tpPct, sl = state.position.slPct;
  el('tpSlTag').textContent =
    (tp != null ? '止盈'+tp+'%' : '') +
    (tp != null && sl != null ? ' / ' : '') +
    (sl != null ? '止损'+sl+'%' : '');
}
function updateTradeButtons(){
  const has = !!state.position;
  el('tradeRow').style.display = has ? 'none' : 'flex';
  el('pnlRow').style.display = has ? 'flex' : 'none';
}
function refreshMarkers(){
  const markers = [];
  state.trades.forEach(t=>{
    markers.push({ time:nearestBarTime(t.entryTime), position:t.direction === 'long' ? 'belowBar' : 'aboveBar',
      color:t.direction === 'long' ? UP : DOWN, shape:t.direction === 'long' ? 'arrowUp' : 'arrowDown',
      text:t.direction === 'long' ? '多' : '空' });
    markers.push({ time:nearestBarTime(t.exitTime), position:t.direction === 'long' ? 'aboveBar' : 'belowBar',
      color:t.pnlPct >= 0 ? UP : DOWN, shape:'circle', text:fmtPct(t.pnlPct) });
  });
  if(state.position){
    markers.push({ time:nearestBarTime(state.position.entryTime),
      position:state.position.direction === 'long' ? 'belowBar' : 'aboveBar',
      color:state.position.direction === 'long' ? UP : DOWN,
      shape:state.position.direction === 'long' ? 'arrowUp' : 'arrowDown',
      text:state.position.direction === 'long' ? '多' : '空' });
  }
  markers.sort((a,b)=>a.time-b.time);
  candleSeries.setMarkers(markers);
}

/* ================= 复盘报告 ================= */
function computeSegmentStats(){
  const cs = state.candles;
  if(!cs.length) return null;
  const open = cs[0].open, close = cs[cs.length-1].close;
  let maxRise = 0, maxDrop = 0, rangeSum = 0, volSum = 0, maxVol = 0, maxVolIdx = 0;
  cs.forEach((c,i)=>{
    const rise = (c.high - open)/open*100;
    const drop = (c.low - open)/open*100;
    if(rise > maxRise) maxRise = rise;
    if(drop < maxDrop) maxDrop = drop;
    rangeSum += (c.high - c.low)/open*100;
    volSum += c.volume;
    if(c.volume > maxVol){ maxVol = c.volume; maxVolIdx = i; }
  });
  const avgVol = volSum/cs.length || 1;
  return {
    open, close,
    changePct:(close - open)/open*100,
    maxRise, maxDrop,
    avgRange:rangeSum/cs.length,
    maxVolRatio:maxVol/avgVol,
    maxVolTime:cs[maxVolIdx].time*1000,
    count:cs.length,
    direction: close >= open ? 'up' : 'down'
  };
}

function maybeShowReport(){
  if(state.reportShown || !state.candles.length) return;
  const last = state.candles[state.candles.length-1];
  if(!last || state.currentTime < last.time*1000) return;
  state.reportShown = true;
  if(state.position) settlePosition(last.close, 'report', last.time*1000);
  const stats = computeSegmentStats();
  renderReport(stats);
  upsertSession({
    symbol:state.symbol, interval:state.interval,
    anchor:state.anchor, segEnd:state.rangeEnd, contextBars:state.contextBars,
    trades:state.trades.slice(), stats
  });
  openSheet('reportSheet','reportBackdrop');
}

function tradeRowsHtml(trades, stats){
  if(!trades.length) return '<div class="trade-empty">本轮没有开仓，先看走势统计，下次尝试开仓判断</div>';
  const segUp = stats && stats.direction === 'up';
  return trades.slice().reverse().map(t=>{
    const withTrend = segUp ? t.direction === 'long' : t.direction === 'short';
    const win = t.pnlPct > 0;
    return `
      <div class="trade-item">
        <div>
          <span class="dir ${t.direction}">${t.direction === 'long' ? '多' : '空'}</span>
          <span class="reason">${reasonText(t.reason)} · ${withTrend ? '顺势' : '逆势'}</span>
          <div style="margin-top:5px; color:var(--text-dim2); font-size:11px;">
            ${fmtTime(t.entryTime)} → ${fmtTime(t.exitTime)}
          </div>
        </div>
        <div style="text-align:right;">
          <div class="pnl" style="color:${t.pnlPct >= 0 ? 'var(--up)' : 'var(--down)'}">${fmtPct(t.pnlPct)}</div>
          <div style="color:var(--text-dim2); font-size:11px; margin-top:3px;">
            ${win ? '✓ 判断正确' : '✗ 判断错误'}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderReport(stats){
  if(!stats) return;
  const dirText = stats.direction === 'up' ? '上涨' : '下跌';
  const dirCls = stats.direction === 'up' ? 'dir-up' : 'dir-down';
  const trades = state.trades;
  const wins = trades.filter(t=>t.pnlPct > 0).length;
  const totalPnl = trades.reduce((s,t)=>s+t.pnlPct, 0);
  const segUp = stats.direction === 'up';
  const withTrendCount = trades.filter(t=> segUp ? t.direction==='long' : t.direction==='short').length;
  el('reportMeta').innerHTML =
    `${state.symbol} · ${state.interval} &nbsp;|&nbsp; ${fmtFull(state.anchor)} 起<br>` +
    `<b>本段实际走势：${dirText} ${fmtPct(stats.changePct)}</b>（共 ${stats.count} 根）`;
  el('reportVerdict').innerHTML = trades.length
    ? `开仓 ${trades.length} 笔，盈利 ${wins} 笔 · 方向正确 ${withTrendCount}/${trades.length} · 合计盈亏 <span class="${totalPnl>=0?'good':'bad'}">${fmtPct(totalPnl)}</span><br>` +
      `评价：<span class="${withTrendCount/trades.length >= 0.5 ? 'good' : 'bad'}">${withTrendCount/trades.length >= 0.5 ? '整体顺势，方向感不错' : '多在逆势开仓，注意顺势而为'}</span>`
    : `本轮没有开仓。${dirText} ${fmtPct(stats.changePct)}，你判断对了吗？下次试着开仓检验。`;
  el('reportStats').innerHTML =
    statCell('区间涨跌', fmtPct(stats.changePct), stats.changePct >= 0 ? 'var(--up)' : 'var(--down)') +
    statCell('最大涨幅', fmtPct(stats.maxRise), 'var(--up)') +
    statCell('最大回撤', fmtPct(stats.maxDrop), 'var(--down)') +
    statCell('平均振幅', stats.avgRange.toFixed(2)+'%') +
    statCell('最大放量', stats.maxVolRatio.toFixed(1)+' 倍') +
    statCell('放量位置', fmtTime(stats.maxVolTime));
  el('reportTrades').innerHTML = tradeRowsHtml(trades, stats);
  el('noteInput').value = state.sessionNote;
}
function statCell(k, v, color){
  return `<div class="stat-box"><div class="k">${k}</div><div class="v" style="${color?`color:${color}`:''}">${v}</div></div>`;
}

function saveNote(){
  state.sessionNote = el('noteInput').value;
  upsertSession({note:state.sessionNote});
  toast('笔记已保存','ok');
}

/* ================= 历史记录 ================= */
function renderHistory(){
  const sessions = loadSessions();
  const list = el('historyList');
  if(!sessions.length){
    list.innerHTML = '<div class="trade-empty">还没有复盘记录<br>抽一段行情练完会自动生成</div>';
    return;
  }
  list.innerHTML = sessions.map(s=>{
    const d = new Date(s.createdAt);
    const dir = s.stats ? (s.stats.direction === 'up' ? '↑' : '↓') : '·';
    const chg = s.stats ? fmtPct(s.stats.changePct) : '--';
    const t = s.trades || [];
    const win = t.length ? Math.round(t.filter(x=>x.pnlPct>0).length/t.length*100)+'%' : '--';
    const pnl = t.reduce((a,x)=>a+x.pnlPct, 0);
    const note = s.note ? s.note.replace(/\n/g,' ').slice(0, 34) : '';
    return `
      <div class="history-item" data-id="${s.id}">
        <div class="hi-top">
          <span class="hi-date">${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}</span>
          <span class="hi-sym">${s.symbol} ${s.interval}</span>
          <span class="hi-dir ${s.stats ? s.stats.direction : ''}">${dir} ${chg}</span>
        </div>
        <div class="hi-mid">${t.length} 笔 · 胜率 ${win} · 合计 <b class="${pnl>=0?'pos':'neg'}">${fmtPct(pnl)}</b></div>
        ${note ? `<div class="hi-note">${escapeHtml(note)}</div>` : ''}
      </div>`;
  }).join('');
  list.querySelectorAll('.history-item').forEach(item=>{
    item.addEventListener('click', ()=>openDetail(item.dataset.id));
  });
}

function getSession(id){
  return loadSessions().find(s=>s.id === id) || null;
}
function openDetail(id){
  const s = getSession(id);
  if(!s) return;
  state.detailId = id;
  const dirText = s.stats ? (s.stats.direction === 'up' ? '上涨' : '下跌') : '--';
  el('detailMeta').innerHTML =
    `${s.symbol} · ${s.interval} &nbsp;|&nbsp; ${new Date(s.createdAt).toLocaleString('zh-CN')}` +
    (s.stats ? `<br><b>本段走势：${dirText} ${fmtPct(s.stats.changePct)}</b>（${s.stats.count} 根）` : '');
  el('detailStats').innerHTML = s.stats
    ? statCell('区间涨跌', fmtPct(s.stats.changePct), s.stats.changePct>=0?'var(--up)':'var(--down)') +
      statCell('最大涨幅', fmtPct(s.stats.maxRise), 'var(--up)') +
      statCell('最大回撤', fmtPct(s.stats.maxDrop), 'var(--down)') +
      statCell('平均振幅', s.stats.avgRange.toFixed(2)+'%') +
      statCell('最大放量', s.stats.maxVolRatio.toFixed(1)+' 倍') +
      statCell('放量位置', fmtTime(s.stats.maxVolTime))
    : '<div class="trade-empty">该记录没有完整统计</div>';
  el('detailTrades').innerHTML = tradeRowsHtml(s.trades || [], s.stats);
  el('detailNote').textContent = s.note || '（无笔记）';
  openSheet('detailSheet','detailBackdrop');
}

async function replayAgain(){
  const s = getSession(state.detailId);
  if(!s) return;
  stopPlay();
  state.symbol = s.symbol;
  state.interval = s.interval;
  state.contextBars = s.contextBars || 100;
  state.anchor = s.anchor;
  state.rangeEnd = s.segEnd;
  state.rangeStart = s.anchor - state.contextBars*INTERVAL_MS[s.interval];
  state.currentTime = s.anchor;
  beginSession(s.id, s.note || '');
  state.drawings = []; state.drawTempPoint = null;
  el('symbol').value = s.symbol;
  document.querySelectorAll('.tf-chip').forEach(b=>b.classList.toggle('active', b.dataset.tf === s.interval));
  closeSheet('detailSheet','detailBackdrop');
  closeSheet('historySheet','historyBackdrop');
  toast('正在载入该复盘段…','');
  try{
    await loadAndRender();
    el('emptyState').style.display = 'none';
    el('hudMini').style.display = 'flex';
    refreshMarkers(); updateTradeButtons();
    toast(`已载入 · ${fmtTime(state.currentTime)}，重新练这段`, 'ok');
  }catch(err){
    toast(err.message || String(err), 'error');
  }
}

function deleteSession(){
  const s = getSession(state.detailId);
  if(!s) return;
  if(!confirm('确定删除这条复盘记录？删除后不可恢复。')) return;
  const sessions = loadSessions().filter(x=>x.id !== state.detailId);
  saveSessions(sessions);
  closeSheet('detailSheet','detailBackdrop');
  renderHistory();
  toast('已删除','ok');
}

/* ================= 导出 ================= */
function download(name, content, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
}
function exportCSV(){
  const sessions = loadSessions();
  if(!sessions.length){ toast('还没有可导出的记录','error'); return; }
  const rows = [['复盘时间','币种','周期','方向','入场时间','入场价','出场时间','出场价','盈亏%','平仓方式','段方向','是否顺势','复盘笔记']];
  sessions.forEach(s=>{
    const segUp = s.stats && s.stats.direction === 'up';
    (s.trades||[]).forEach(t=>{
      const withTrend = segUp != null && (t.direction === 'long') === segUp;
      rows.push([
        fmtFull(s.createdAt), s.symbol, s.interval,
        t.direction === 'long' ? '多' : '空',
        fmtFull(t.entryTime), t.entryPrice, fmtFull(t.exitTime), t.exitPrice,
        t.pnlPct.toFixed(2), reasonText(t.reason),
        segUp == null ? '' : (segUp ? '涨' : '跌'),
        withTrend ? '顺势' : '逆势',
        (s.note||'').replace(/\n/g,' ')
      ]);
    });
  });
  const csv = '\uFEFF' + rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  download('K线复盘-交易记录.csv', csv, 'text/csv;charset=utf-8');
  toast('CSV 已导出','ok');
}
function exportJSON(){
  const sessions = loadSessions();
  if(!sessions.length){ toast('还没有可导出的记录','error'); return; }
  download('K线复盘-全部数据.json', JSON.stringify(sessions, null, 2), 'application/json');
  toast('JSON 已导出','ok');
}

/* ================= 进步统计 ================= */
function drawCurve(canvas, values, color){
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || canvas.parentElement.clientWidth - 4;
  const H = 150;
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px sans-serif';
  if(values.length < 2){
    ctx.fillStyle = '#93a1b4';
    ctx.fillText('数据不足，多复盘几轮再来看', 14, 24);
    return;
  }
  const pad = 30, top = 16, bottom = 22, h = H - top - bottom;
  let mn = Math.min(...values), mx = Math.max(...values);
  const span = mx - mn;
  if(span < 1e-6){ mn -= 1; mx += 1; }
  const xAt = i => pad + i*(W - pad*2)/Math.max(1, values.length-1);
  const yAt = v => top + (1 - (v - mn)/(mx - mn))*h;
  ctx.strokeStyle = '#e3e9f1';
  ctx.lineWidth = 1;
  for(let g = 0; g <= 2; g++){
    const y = top + g*h/2;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  values.forEach((v,i)=>{
    const x = xAt(i), y = yAt(v);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = color;
  values.forEach((v,i)=>{
    ctx.beginPath(); ctx.arc(xAt(i), yAt(v), 2.6, 0, Math.PI*2); ctx.fill();
  });
  const last = values[values.length-1];
  ctx.fillStyle = color;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText((last>=0?'+':'') + last.toFixed(1) + '%', Math.min(W - pad - 70, W - 80), yAt(last) - 8);
}
function renderStats(){
  const sessions = loadSessions();
  const done = sessions.filter(s=>s.stats);
  const allTrades = sessions.flatMap(s=>s.trades || []);
  const total = allTrades.length;
  const wins = allTrades.filter(t=>t.pnlPct > 0).length;
  const sumPnl = allTrades.reduce((a,t)=>a+t.pnlPct, 0);
  el('sTotal').textContent = done.length;
  el('sTrades').textContent = total;
  el('sWin').textContent = total ? Math.round(wins/total*100)+'%' : '--';
  const pnlEl = el('sPnl');
  pnlEl.textContent = fmtPct(sumPnl);
  pnlEl.style.color = sumPnl >= 0 ? 'var(--up)' : 'var(--down)';
  el('sWeek').textContent = sessions.filter(s=>Date.now() - s.createdAt < 7*86400000).length;
  el('sAvg').textContent = total ? fmtPct(sumPnl/total) : '--';
  const seq = done.slice().reverse(); // 旧的在前
  const winVals = seq.map(s=>{
    const t = s.trades || [];
    return t.length ? Math.round(t.filter(x=>x.pnlPct>0).length/t.length*100) : null;
  }).filter(v=>v != null);
  let cum = 0;
  const pnlVals = seq.map(s=>{
    cum += (s.trades||[]).reduce((a,t)=>a+t.pnlPct, 0);
    return cum;
  }).filter((v,i,a)=>a.length ? true : false);
  drawCurve(el('winCanvas'), winVals, ACCENT);
  drawCurve(el('pnlCanvas'), pnlVals, UP);
}

/* ================= 画线工具 ================= */
const overlay = el('drawOverlay');
function resizeOverlay(){
  const rect = el('chart-container').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = rect.width*dpr;
  overlay.height = rect.height*dpr;
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function renderOverlay(){
  const rect = el('chart-container').getBoundingClientRect();
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, rect.width, rect.height);
  state.drawings.forEach(d=>drawOne(ctx, d, rect));
}
function drawOne(ctx, d, rect){
  if(d.type === 'hline'){
    const y = candleSeries.priceToCoordinate(d.price);
    if(y == null) return;
    ctx.strokeStyle = ACCENT; ctx.setLineDash([5,4]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ACCENT; ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    ctx.fillText(fmtPrice(d.price), 4, y - 4);
  }else if(d.type === 'trend'){
    const x1 = chart.timeScale().timeToCoordinate(d.p1.time), y1 = candleSeries.priceToCoordinate(d.p1.price);
    const x2 = chart.timeScale().timeToCoordinate(d.p2.time), y2 = candleSeries.priceToCoordinate(d.p2.price);
    if(x1 == null || y1 == null || x2 == null || y2 == null) return;
    ctx.strokeStyle = '#4f8ef7'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.fillStyle = '#4f8ef7';
    [[x1,y1],[x2,y2]].forEach(p=>{ ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI*2); ctx.fill(); });
  }else if(d.type === 'fib'){
    const x1 = chart.timeScale().timeToCoordinate(d.p1.time), x2 = chart.timeScale().timeToCoordinate(d.p2.time);
    if(x1 == null || x2 == null) return;
    const left = Math.min(x1, x2);
    FIB_LEVELS.forEach(l=>{
      const price = d.p1.price + (d.p2.price - d.p1.price)*l;
      const y = candleSeries.priceToCoordinate(price);
      if(y == null) return;
      ctx.strokeStyle = 'rgba(30,111,255,0.5)'; ctx.setLineDash([3,3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(rect.width, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#4f8ef7'; ctx.font = '9px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      ctx.fillText(l.toFixed(3) + ' · ' + fmtPrice(price), left + 4, y - 3);
    });
  }
}
(function overlayLoop(){
  requestAnimationFrame(overlayLoop);
  if(state.candles.length) renderOverlay();
})();

function setDrawMode(mode){
  state.drawMode = mode;
  state.drawTempPoint = null;
  document.querySelectorAll('.draw-toolbar button[data-mode]').forEach(b=>b.classList.toggle('active', b.dataset.mode === mode));
  overlay.style.pointerEvents = mode === 'none' ? 'none' : 'auto';
}

/* ================= 事件绑定 ================= */
function bindCloseButtons(){
  document.querySelectorAll('[data-close]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.close;
      closeSheet(id, id.replace('Sheet','Backdrop'));
    });
  });
  [['settingsBackdrop','settingsSheet'],['tradeBackdrop','tradeSheet'],['reportBackdrop','reportSheet'],
   ['historyBackdrop','historySheet'],['detailBackdrop','detailSheet'],['statsBackdrop','statsSheet']]
    .forEach(([bd, sh])=>{
      el(bd).addEventListener('click', ()=>closeSheet(sh, bd));
    });
}

function initEvents(){
  bindCloseButtons();

  el('drawToggleBtn').addEventListener('click', ()=>{
    const showing = el('drawToolbar').style.display === 'flex';
    if(showing){
      el('drawToolbar').style.display = 'none';
      setDrawMode('none');
      el('drawToggleBtn').classList.remove('active');
    }else{
      el('drawToolbar').style.display = 'flex';
      el('drawToggleBtn').classList.add('active');
    }
  });
  el('exitDrawBtn').addEventListener('click', ()=>{
    el('drawToolbar').style.display = 'none';
    setDrawMode('none');
    el('drawToggleBtn').classList.remove('active');
  });
  document.querySelectorAll('.draw-toolbar button[data-mode]').forEach(b=>{
    b.addEventListener('click', ()=>{
      setDrawMode(state.drawMode === b.dataset.mode ? 'none' : b.dataset.mode);
      if(state.drawMode !== 'none'){
        toast(state.drawMode === 'hline' ? '点击图表放置水平线' : '点击图表选择第一个点','');
      }
    });
  });
  el('undoDrawBtn').addEventListener('click', ()=>{ state.drawings.pop(); });
  el('clearDrawBtn').addEventListener('click', ()=>{ state.drawings = []; toast('已清除所有画线',''); });

  overlay.addEventListener('pointerdown', e=>{
    if(state.drawMode === 'none' || !state.candles.length) return;
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = candleSeries.coordinateToPrice(y);
    if(time == null || price == null) return;
    if(state.drawMode === 'hline'){
      state.drawings.push({type:'hline', price});
      toast('已添加水平线 ' + fmtPrice(price), 'ok');
      return;
    }
    if(!state.drawTempPoint){
      state.drawTempPoint = {time, price};
      toast('已选第一个点，再点第二个点','');
    }else{
      const p1 = state.drawTempPoint, p2 = {time, price};
      state.drawTempPoint = null;
      if(state.drawMode === 'trend'){ state.drawings.push({type:'trend', p1, p2}); toast('已添加趋势线','ok'); }
      else if(state.drawMode === 'fib'){ state.drawings.push({type:'fib', p1, p2}); toast('已添加斐波那契回撤','ok'); }
    }
  });

  el('settingsToggleBtn').addEventListener('click', ()=>openSheet('settingsSheet','settingsBackdrop'));
  el('emptyDrawBtn').addEventListener('click', ()=>openSheet('settingsSheet','settingsBackdrop'));
  el('browseToggleBtn').addEventListener('click', ()=>{ state.mode === 'browse' ? backToReplay() : enterBrowseMode(); });
  el('browseLoadBtn').addEventListener('click', browseLoad);
  el('browseBackBtn').addEventListener('click', backToReplay);
  el('drawBtn').addEventListener('click', startNewRound);
  el('longBtn').addEventListener('click', ()=>openPositionSheet('long'));
  el('shortBtn').addEventListener('click', ()=>openPositionSheet('short'));
  el('confirmOpenBtn').addEventListener('click', confirmOpen);
  el('closeBtn').addEventListener('click', ()=>{
    const last = lastVisibleCandle();
    if(last) settlePosition(last.close, 'manual', state.currentTime);
  });
  bindChips('tpChips','tpInput');
  bindChips('slChips','slInput');

  el('playBtn').addEventListener('click', togglePlay);
  el('stepFwdBtn').addEventListener('click', ()=>stepForward(1));
  el('stepBackBtn').addEventListener('click', stepBackward);
  el('revealBtn').addEventListener('click', revealAll);
  el('speedSel').addEventListener('change', ()=>{ if(state.playing){ stopPlay(); play(); } });

  el('tfStrip').addEventListener('click', e=>{
    const btn = e.target.closest('.tf-chip');
    if(!btn || btn.classList.contains('disabled')) return;
    document.querySelectorAll('.tf-chip').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    switchInterval(btn.dataset.tf);
  });

  el('saveNoteBtn').addEventListener('click', saveNote);
  el('closeReportBtn').addEventListener('click', ()=>closeSheet('reportSheet','reportBackdrop'));
  el('historyToggleBtn').addEventListener('click', ()=>{ renderHistory(); openSheet('historySheet','historyBackdrop'); });
  el('exportCsvBtn').addEventListener('click', exportCSV);
  el('exportJsonBtn').addEventListener('click', exportJSON);
  el('replayAgainBtn').addEventListener('click', replayAgain);
  el('deleteSessionBtn').addEventListener('click', deleteSession);
  el('statsToggleBtn').addEventListener('click', ()=>{ renderStats(); openSheet('statsSheet','statsBackdrop'); });
  el('dataSource').addEventListener('change', e=>{
    state.dataSource = e.target.value;
    saveSettings();
    updateTfAvailability();
    if(state.dataSource === 'bundle' && !BUNDLE_INTERVALS.includes(state.interval)){
      state.interval = '5m';
      document.querySelectorAll('.tf-chip').forEach(b=>b.classList.toggle('active', b.dataset.tf === '5m'));
    }
    toast(state.dataSource === 'demo' ? '已切换到内置模拟行情' : '已切换到本地数据包', 'ok');
  });
}

/* ================= Service Worker / 安装提示 ================= */
if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredPrompt = e;
  if(!sessionStorage.getItem('btcPwaHintShown')){
    sessionStorage.setItem('btcPwaHintShown','1');
    toast('可在浏览器菜单「添加到主屏幕」安装', '');
  }
});

/* ================= 初始化 ================= */
(function init(){
  const today = new Date();
  const startDefault = new Date(today.getTime() - 120*86400000);
  const saved = loadSettings();
  el('rangeEnd').value = today.toISOString().slice(0,10);
  el('rangeStart').value = startDefault.toISOString().slice(0,10);
  if(saved.symbol) el('symbol').value = saved.symbol;
  if(saved.rangeStart) el('rangeStart').value = saved.rangeStart;
  if(saved.rangeEnd) el('rangeEnd').value = saved.rangeEnd;
  if(saved.contextBars) el('contextBars').value = saved.contextBars;
  const ds = (saved.dataSource && ['bundle','demo'].includes(saved.dataSource)) ? saved.dataSource : 'bundle';
  el('dataSource').value = ds;
  state.dataSource = ds;

  (async function applyBundle(){
    await initBundleMeta();
    const bounds = bundlePackBounds();
    if(bounds){
      const packEndDate = new Date(bounds.end).toISOString().slice(0,10);
      const packStartDate = new Date(bounds.start).toISOString().slice(0,10);
      const todayStr = today.toISOString().slice(0,10);
      el('rangeEnd').value = packEndDate < todayStr ? packEndDate : todayStr;
      const defStart = new Date(bounds.end - 120*86400000).toISOString().slice(0,10);
      el('rangeStart').value = defStart < packStartDate ? packStartDate : defStart;
      const hint = el('dataPackHint');
      if(hint) hint.textContent = `本地数据包：${packStartDate} ~ ${packEndDate}。5m 近 2 年 / 1h 近 5 年 / 1d 近 6 年，数据截至打包日，不自动更新。`;
    }
    if(state.dataSource === 'bundle' && !BUNDLE_INTERVALS.includes(state.interval)){
      state.interval = '5m';
      document.querySelectorAll('.tf-chip').forEach(b=>b.classList.toggle('active', b.dataset.tf === '5m'));
    }
    updateTfAvailability();
  })();

  initEvents();
  resizeCharts();
})();

})();
