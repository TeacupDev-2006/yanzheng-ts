/**
 * 研证 Web 形态（Hono）。
 *
 * 页面职责分离：
 *   GET  /config   评卷委员会配置页（AI 设置 + 评审团编制编辑器，保存到服务端 data/rubric.json）
 *   GET  /         投稿页（轻量：上传论文即送审；展示当前生效配置摘要 + 可选临时 Key 覆盖）
 *   POST /review   评卷（配置取服务端保存值；表单里的临时 Key 优先）
 *   POST /api/config   保存配置（校验经 normalizePanels；apiKey 未传 = 保留原值）
 *   POST /llm/models   拉取公网端点模型清单（SSRF 守卫）
 *   GET  /health   健康检查
 *
 * 无任何 key 时自动进入演示模式（确定性 mock，页面明确标注）。
 */

import { Hono } from 'hono'
import {
  reviewPaper,
  renderHtml,
  demoMockLLM,
  normalizePanels,
  listModels,
  ALL_PANELS,
  AVAILABLE_SKILLS,
  type PanelSpec,
} from '@yanzheng/core'
import { loadConfig, saveConfig } from './config-store.js'

export const ALLOW_EXT = ['.pdf', '.txt', '.md']
export const MAX_UPLOAD = 20 * 1024 * 1024

const DEEPSEEK_BASE = 'https://api.deepseek.com'
const DEEPSEEK_JUDGE_MODEL = 'deepseek-flash'
const DEEPSEEK_ARBITER_MODEL = 'deepseek-v4-pro'

export function createApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      mode: process.env.DEEPSEEK_API_KEY ? 'real' : 'demo',
      runtime: 'typescript/agh-native',
    }),
  )

  /** 拉取用户自备公网端点的模型清单（SSRF 守卫；本地端点不提供拉取）。 */
  app.post('/llm/models', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: string; key?: string } | null
    const url = String(body?.url ?? '').trim()
    if (!url) return c.json({ error: '缺少端点地址' }, 400)
    if (!/^https?:\/\//.test(url)) {
      return c.json({ error: '端点仅允许 http/https' }, 400)
    }
    try {
      const models = await listModels({ baseUrl: url, apiKey: body?.key || null })
      return c.json({ models })
    } catch (exc) {
      return c.json({ error: exc instanceof Error ? exc.message : String(exc) }, 502)
    }
  })

  /** 保存配置。llm.apiKey 未出现在请求体里 = 保留已存值（避免页面掩码回写清空）。 */
  app.post('/api/config', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: '请求体不是合法 JSON' }, 400)
    try {
      const saved = await saveConfig(body)
      return c.json({ ok: true, panels: saved.panels.length, judges: saved.panels.reduce((a, p) => a + p.judges.length, 0) })
    } catch (exc) {
      return c.json({ error: exc instanceof Error ? exc.message : String(exc) }, 400)
    }
  })

  /** 配置页：评审团编制编辑器 + AI 设置（专职页面）。 */
  app.get('/config', async (c) => {
    const cfg = await loadConfig()
    const safe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
    return c.html(
      CONFIG_HTML.replace('__SKILLS__', () => safe(AVAILABLE_SKILLS))
        .replace('__PANELS__', () => safe(cfg.panels))
        .replace('__LLM__', () => safe({ ...cfg.llm, apiKey: cfg.llm.apiKey ? '已保存（留空即保持不变）' : '' }))
        .replaceAll('__DS_BASE__', () => DEEPSEEK_BASE)
        .replaceAll('__DS_JUDGE__', () => DEEPSEEK_JUDGE_MODEL)
        .replaceAll('__DS_ARBITER__', () => DEEPSEEK_ARBITER_MODEL),
    )
  })

  /** 投稿页（轻量）：当前配置摘要 + 上传送审 + 可选临时 Key 覆盖。 */
  app.get('/', async (c) => {
    const cfg = await loadConfig()
    const hasEnvKey = Boolean(process.env.DEEPSEEK_API_KEY)
    const effectiveKey = cfg.llm.apiKey || (hasEnvKey ? 'env' : null)
    const demoBadge = effectiveKey
      ? '<span class="badge ink">真实评卷 · 评卷团已就位</span>'
      : '<span class="badge">演示模式 · 未配置审稿人（结果为确定性 mock）</span>'
    const judgeTotal = cfg.panels.reduce((a, p) => a + p.judges.length, 0)
    const totalMax = cfg.panels.reduce((a, p) => a + p.maxScore, 0)
    const summaryRows = cfg.panels
      .map(
        (p) =>
          `<tr><td>${esc(p.name)}</td><td class="num">${p.judges.length}</td>` +
          `<td class="num">${p.maxScore}</td><td>${esc(p.judges.map((j) => j.name).join('、'))}</td></tr>`,
      )
      .join('')
    const reviewerShort = esc(
      presetLabel(cfg.llm.preset) + (cfg.llm.modelJudge ? ` · ${cfg.llm.modelJudge}` : ''),
    )
    const summary = `
    <div class="cfg-card">
      <div class="cfg-top"><b>当前生效编制</b><a class="cfg-edit" href="/config">修 改</a></div>
      <div class="stats">
        <div class="stat"><div class="n">${cfg.panels.length}</div><div class="t">评审团</div><div class="s">&nbsp;</div></div>
        <div class="stat"><div class="n">${judgeTotal}</div><div class="t">评卷员</div><div class="s">&nbsp;</div></div>
        <div class="stat"><div class="n red">${totalMax}</div><div class="t">总分制</div><div class="s">及格 ${Math.round(totalMax * 0.6)}</div></div>
        <div class="stat"><div class="n" style="font-size:14px;padding-top:5px">${reviewerShort}</div><div class="t">审稿人</div><div class="s">${cfg.llm.apiKey ? 'key 已配置' : '演示模式'}</div></div>
      </div>
      <details><summary>展开评审团明细</summary>
        <table><thead><tr><th>评审团</th><th>员数</th><th>满分</th><th>评卷员</th></tr></thead>
        <tbody>${summaryRows}</tbody></table>
      </details>
    </div>`
    return c.html(
      INDEX_HTML.replace('<!--BADGE-->', () => demoBadge)
        .replace('<!--CFG_SUMMARY-->', () => summary)
        .replace('__DS_JUDGE__', () => DEEPSEEK_JUDGE_MODEL)
        .replace('__DS_ARBITER__', () => DEEPSEEK_ARBITER_MODEL),
    )
  })

  app.post('/review', async (c) => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) {
      return c.text('缺少文件字段 file', 400)
    }
    const name = file.name || '论文.txt'
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!ALLOW_EXT.includes(ext)) {
      return c.text(`仅支持 ${ALLOW_EXT.join('/')} 文件`, 400)
    }
    if (file.size > MAX_UPLOAD) {
      return c.text('文件超过 20MB', 400)
    }
    const minWords = Number.parseInt(String(form.min_words ?? '10000'), 10) || 10000
    const online = String(form.online ?? '') === '1'

    // 配置：服务端保存值为基底；表单临时 Key 优先（不改已存配置）
    const cfg = await loadConfig()
    const tempKey = String(form.llm_key ?? '').trim()
    const apiKey = tempKey || cfg.llm.apiKey || null

    const data = Buffer.from(await file.arrayBuffer())
    const text = ext === '.pdf' ? await pdfTextOf(data) : data.toString('utf-8')

    try {
      const report = await reviewPaper({
        text,
        title: name.replace(/\.[^.]+$/, ''),
        corpus: {},
        online,
        apiKey,
        mockFn: apiKey ? null : demoMockLLM,
        minWords,
        panels: cfg.panels,
        baseUrl: cfg.llm.baseUrl || undefined,
        modelFlash: cfg.llm.modelJudge || undefined,
        modelPro: cfg.llm.modelArbiter || undefined,
        thinkingStyle: cfg.llm.thinkingStyle,
      })
      return c.html(renderHtml(report))
    } catch (exc) {
      return c.text(`评卷失败：${exc instanceof Error ? exc.message : String(exc)}`, 502)
    }
  })

  return app
}

function presetLabel(preset: string): string {
  const names: Record<string, string> = {
    deepseek: 'DeepSeek',
    kimi: 'Kimi',
    qwen: 'Qwen 通义千问',
    glm: 'GLM',
    doubao: '豆包',
    ernie: '文心一言',
    hunyuan: '混元',
    spark: '星火',
    minimax: 'MiniMax',
    custom: '自定义端点',
  }
  return names[preset] ?? preset
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** pdf 内存抽取文本（unpdf）。 */
async function pdfTextOf(data: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(data))
  const { text } = await extractText(pdf, { mergePages: true })
  return (Array.isArray(text) ? text.join('\n') : text) ?? ''
}

// ---------------------------------------------------------------------------
// 投稿页（轻量）
// ---------------------------------------------------------------------------

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>研证 · 评卷纪要</title>
<style>
  :root { --paper:#FAF6EE; --ink:#1c1a17; --red:#A63D2F; --hair:#D9D2C2; --dim:#6E675B; --wash:#F3EDE0;
          --ok:#1a7a3a; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin:0; background:var(--paper); color:var(--ink);
        font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
        line-height:1.7; }
  .spine { position:fixed; right:26px; top:50%; transform:translateY(-50%);
          writing-mode:vertical-rl; letter-spacing:.5em; font-size:12px; color:var(--dim);
          border-left:1px solid var(--hair); padding-left:10px; user-select:none; }
  @media (max-width: 900px) { .spine { display:none; } }
  main { max-width: 640px; margin: 0 auto; padding: 28px 18px 60px; }
  .dateline { text-align:center; font-size:12px; letter-spacing:.28em; color:var(--dim);
             border-bottom:1px solid var(--ink); padding-bottom:8px; }
  .masthead { text-align:center; padding: 26px 0 10px; }
  .masthead h1 { margin:0; font-size:64px; font-weight:900; letter-spacing:.08em; }
  .masthead h1 .dot { color: var(--red); }
  .eng { text-align:center; font-size:11px; letter-spacing:.52em; color:var(--dim);
        margin:6px 0 18px; text-transform:uppercase; }
  .double { border-top:3px solid var(--ink); border-bottom:1px solid var(--ink);
           height:5px; margin: 2px 0 22px; }
  .lede { text-align:center; font-style:italic; color:var(--dim); font-size:15px;
         margin:0 0 22px; }
  .badge { display:inline-block; font-size:12px; letter-spacing:.12em; color:var(--red);
          border:1px solid var(--red); padding:3px 14px; margin-bottom:22px; }
  .badge.ink { color:#fff; background:var(--ink); border-color:var(--ink); }
  /* 配置摘要：指标块 */
  .cfg-card { border:1px solid var(--hair); background:#FFFDF8; padding:14px 14px 12px; margin-bottom:26px; }
  .cfg-top { display:flex; align-items:center; justify-content:space-between; gap:8px;
            border-bottom:1px solid var(--hair); padding-bottom:8px; margin-bottom:12px; }
  .cfg-top b { font-size:13px; letter-spacing:.2em; }
  .cfg-edit { font-size:12.5px; color:var(--red); border:1px solid var(--red);
             padding:2px 10px; text-decoration:none; white-space:nowrap; }
  .cfg-edit:hover { background:var(--red); color:#fff; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
  @media (max-width:520px) { .stats { grid-template-columns:repeat(2,1fr); } }
  .stat { text-align:center; background:var(--wash); padding:8px 4px 6px; }
  .stat .n { font-size:22px; font-weight:900; line-height:1.2; font-variant-numeric:tabular-nums; }
  .stat .n.red { color:var(--red); }
  .stat .t { font-size:11px; color:var(--dim); letter-spacing:.14em; }
  .stat .s { font-size:11px; color:var(--dim); overflow:hidden; text-overflow:ellipsis;
            white-space:nowrap; }
  .cfg-card details { margin-top:10px; }
  .cfg-card summary { cursor:pointer; font-size:12.5px; color:var(--dim); }
  .cfg-card table { width:100%; border-collapse:collapse; font-size:12.5px; margin-top:8px; }
  .cfg-card th, .cfg-card td { border-bottom:1px solid var(--hair); padding:5px 6px; text-align:left; }
  .cfg-card th { color:var(--dim); font-weight:700; background:var(--wash); }
  .cfg-card tr:nth-child(even) td { background:#FBF7EE; }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .section-label { text-align:center; font-size:12px; letter-spacing:.4em; color:var(--red);
                  margin: 26px 0 14px; }
  form { border-top:1px solid var(--hair); padding-top:8px; }
  /* 上传区 */
  .drop { border:1.5px dashed var(--hair); background:#FFFDF8; padding:26px 16px 20px;
         text-align:center; color:var(--dim); font-size:14px; margin-bottom:20px;
         transition:border-color .15s, background .15s; }
  .drop b { color:var(--ink); }
  .drop .fmt { font-size:12px; margin-top:2px; }
  .drop.drag { border-color:var(--red); background:#F7EDE4; }
  .drop input[type=file] { width:100%; margin-top:12px; font-family:inherit; }
  .file-chip { display:none; margin:10px auto 0; max-width:90%;
              border:1px solid var(--hair); background:var(--wash); padding:3px 10px;
              font-size:12.5px; color:var(--ink); }
  .file-chip.show { display:inline-block; }
  label { display:block; font-size:13px; letter-spacing:.18em; color:var(--dim);
         margin:18px 0 6px; }
  .quick { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  .quick button { width:auto; margin:0; padding:3px 12px; background:transparent; color:var(--dim);
          border:1px solid var(--hair); font-size:12px; letter-spacing:.08em; text-indent:0; }
  .quick button:hover { border-color:var(--red); color:var(--red); background:transparent; }
  .quick button.on { background:var(--ink); color:var(--paper); border-color:var(--ink); }
  input[type=number], input[type=password] { width:100%; padding:8px 2px; border:0;
        border-bottom:1px solid var(--ink); background:transparent; font:inherit;
        font-size:16px; border-radius:0; }
  input:focus { outline:none; border-bottom-color:var(--red); }
  details.adv { margin-top:22px; border:1px solid var(--hair); background:#FFFDF8; }
  details.adv summary { cursor:pointer; padding:10px 12px; font-size:13px; letter-spacing:.14em;
               color:var(--dim); list-style:none; }
  details.adv summary::before { content:"▸ "; color:var(--red); }
  details.adv[open] summary::before { content:"▾ "; }
  details.adv .inner { padding:0 12px 14px; }
  .check { display:flex; align-items:baseline; gap:8px; margin-top:18px; font-size:14px; }
  .check input { width:auto; accent-color: var(--red); }
  button.go { width:100%; margin-top:26px; padding:14px; background:var(--ink); color:var(--paper);
          border:0; font:inherit; font-size:17px; letter-spacing:.5em; text-indent:.5em;
          cursor:pointer; transition:background .15s; }
  button.go:hover { background:var(--red); }
  button.go:disabled { opacity:.55; cursor:wait; }
  .note { font-size:12.5px; color:var(--dim); margin-top:16px; text-align:center;
         font-style:italic; }
  .rule { border:0; border-top:1px solid var(--hair); margin:30px 0 0; }
  .colophon { text-align:center; font-size:11.5px; color:var(--dim); margin-top:14px;
             letter-spacing:.1em; }
  .colophon a { color:var(--red); }
  .stamp { display:inline-block; margin-top:18px; border:2.5px solid var(--red); color:var(--red);
          font-size:30px; font-weight:900; padding:6px 14px; letter-spacing:.2em;
          transform:rotate(-7deg); border-radius:4px; opacity:.85; }
</style></head><body>
<div class="spine">毕业论文评卷纪要 · 全一册</div>
<main>
  <div class="dateline">第 一 期 · 二〇二六年十月 · 毕业论文评卷特辑</div>
  <div class="masthead"><h1>研<span class="dot">·</span>证</h1></div>
  <div class="eng">Yanzheng — The Thesis Review</div>
  <div class="double"></div>
  <p class="lede">各团各员，各凭证据独立执笔；分差则仲裁，作假者否决。——本刊评卷章程</p>
  <div style="text-align:center"><!--BADGE--></div>
  <!--CFG_SUMMARY-->

  <div class="section-label">投 稿</div>
  <form id="cfg" action="/review" method="post" enctype="multipart/form-data">
    <div class="drop" id="drop">
      <div style="font-size:26px;line-height:1">⌘</div>
      <div style="margin-top:6px">拖拽稿件到此，或点击下方选择文件</div>
      <div class="fmt">本刊受理 <b>.pdf / .txt / .md</b>，篇幅以 20MB 为限</div>
      <input type="file" name="file" id="file" accept=".pdf,.txt,.md" required>
      <span class="file-chip" id="file-chip"></span>
    </div>
    <label>门 检 最 低 字 数</label>
    <input type="number" name="min_words" id="min_words" value="10000" min="0">
    <div class="quick">
      <button type="button" data-w="200">快速试投 · 200</button>
      <button type="button" data-w="5000">课程论文 · 5000</button>
      <button type="button" data-w="10000" class="on">毕业论文 · 10000</button>
    </div>
    <details class="adv">
      <summary>高级选项 · 临时更换审稿人 / 在线核查</summary>
      <div class="inner">
        <label style="margin-top:10px">临 时 API KEY（仅本次评卷优先使用，不改已保存配置）</label>
        <input type="password" name="llm_key" autocomplete="off" placeholder="留空 = 使用配置页保存的审稿人">
        <div class="check"><input type="checkbox" name="online" value="1" id="online">
          <label for="online" style="margin:0;letter-spacing:.05em">启用在线核查（Crossref 验引用 · OpenAlex 检文献）</label></div>
      </div>
    </details>
    <button type="submit" class="go" id="go">送 申 评 卷</button>
    <p class="note">评卷时长取决于编制规模与模型档位：评卷员并行独立打分，其后两级仲裁复核。请勿离席。</p>
  </form>

  <hr class="rule">
  <div class="colophon">评审团编制、审稿人（AI）与型号，请移步<a href="/config">评卷委员会配置页</a><br>
  查重不过者打回 · 作假成立者一票否决</div>
  <div style="text-align:center"><span class="stamp">阅</span></div>
</main>
<script>
  // 字数快捷档
  var mw = document.getElementById('min_words');
  document.querySelectorAll('.quick button').forEach(function(b) {
    b.addEventListener('click', function() {
      mw.value = b.getAttribute('data-w');
      document.querySelectorAll('.quick button').forEach(function(x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
  });
  mw.addEventListener('input', function() {
    document.querySelectorAll('.quick button').forEach(function(x) {
      x.classList.toggle('on', x.getAttribute('data-w') === mw.value);
    });
  });
  // 上传：文件名回显 + 拖拽高亮
  var file = document.getElementById('file'), chip = document.getElementById('file-chip'), drop = document.getElementById('drop');
  file.addEventListener('change', function() {
    var f = file.files[0];
    if (f) {
      chip.textContent = '已选：' + f.name + '（' + (f.size / 1024).toFixed(0) + ' KB）';
      chip.classList.add('show');
    } else {
      chip.classList.remove('show');
    }
  });
  ['dragenter', 'dragover'].forEach(function(ev) {
    drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function(ev) {
    drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function(e) {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      file.files = e.dataTransfer.files;
      file.dispatchEvent(new Event('change'));
    }
  });
  document.getElementById('cfg').addEventListener('submit', function() {
    var b = document.getElementById('go');
    b.disabled = true; b.textContent = '评 卷 中 · 请 候';
  });
</script>
</body></html>`

// ---------------------------------------------------------------------------
// 配置页（专职）
// ---------------------------------------------------------------------------

const CONFIG_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>评卷委员会配置 · 研证</title>
<style>
  :root { --paper:#FAF6EE; --ink:#1c1a17; --red:#A63D2F; --hair:#D9D2C2; --dim:#6E675B; --wash:#F3EDE0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
        font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
        line-height:1.7; }
  main { max-width: 720px; margin: 0 auto; padding: 26px 18px 70px; }
  .dateline { text-align:center; font-size:12px; letter-spacing:.28em; color:var(--dim);
             border-bottom:1px solid var(--ink); padding-bottom:8px; }
  .masthead { text-align:center; padding: 22px 0 6px; }
  .masthead h1 { margin:0; font-size:40px; font-weight:900; letter-spacing:.08em; }
  .masthead h1 .dot { color: var(--red); }
  .eng { text-align:center; font-size:11px; letter-spacing:.5em; color:var(--dim);
        margin:4px 0 14px; text-transform:uppercase; }
  .double { border-top:3px solid var(--ink); border-bottom:1px solid var(--ink); height:5px; margin: 2px 0 18px; }
  .section-label { text-align:center; font-size:12px; letter-spacing:.4em; color:var(--red);
                  margin: 26px 0 14px; }
  label { display:block; font-size:13px; letter-spacing:.14em; color:var(--dim); margin:14px 0 4px; }
  input[type=text], input[type=password], input[type=url], textarea, select {
        width:100%; padding:8px 6px; border:1px solid var(--hair); background:#FFFDF8;
        font:inherit; font-size:14px; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--red); }
  textarea { resize:vertical; }
  button { padding:8px 14px; background:var(--ink); color:var(--paper);
          border:0; font:inherit; font-size:13px; letter-spacing:.2em; cursor:pointer; }
  button:hover { background:var(--red); }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--hair); }
  button.ghost:hover { border-color:var(--red); color:var(--red); background:transparent; }
  .cfg-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 14px; }
  @media (max-width:560px) { .cfg-grid { grid-template-columns:1fr; } }
  .panel-card { border:1px solid var(--hair); background:#FFFDF8; padding:12px 12px 10px; margin:12px 0; }
  .panel-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .panel-head .idx { font-size:12px; letter-spacing:.2em; color:var(--red); white-space:nowrap; }
  .panel-head input.pname { flex:1 1 160px; }
  .panel-head input.max { width:92px; }
  .panel-head label.short { margin:0; font-size:11px; white-space:nowrap; }
  .judge-card { border:1px dotted var(--hair); padding:10px; margin:10px 0 0; }
  .judge-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .judge-head input.jname { flex:1 1 130px; }
  .judge-head select.tier { width:110px; }
  .judge-persona { margin-top:8px; font-size:13px; min-height:52px; }
  .skills { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; font-size:12.5px; }
  .skills label { margin:0; letter-spacing:.02em; display:flex; gap:4px; align-items:baseline; color:var(--ink); }
  .skills input { accent-color:var(--red); }
  .row-btns { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .cfg-actions { display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; justify-content:center; }
  .subnote { font-size:12px; color:var(--dim); margin:6px 0 0; }
  .save-bar { position:sticky; bottom:0; background:var(--paper); border-top:1px solid var(--ink);
             padding:12px 0; display:flex; gap:12px; align-items:center; justify-content:center; flex-wrap:wrap; }
  .save-bar button { padding:12px 26px; font-size:15px; letter-spacing:.3em; }
  #save-status { font-size:13px; }
  #save-status.ok { color:#1a7a3a; }
  #save-status.ok a { color:#1a7a3a; }
  #save-status.err { color:var(--red); }
  .back { text-align:center; margin-top:8px; font-size:13px; }
  .back a { color:var(--red); }
  .home-link { position:absolute; top:20px; right:18px; font-size:12.5px; color:var(--ink);
              border:1px solid var(--hair); padding:3px 10px; text-decoration:none; }
  .home-link:hover { border-color:var(--red); color:var(--red); }
  main { position:relative; }
  /* 型号速选 chips */
  .mchips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .mchips button { padding:2px 10px; background:transparent; color:var(--dim);
          border:1px solid var(--hair); font-size:12px; letter-spacing:.02em; text-indent:0; }
  .mchips button:hover { border-color:var(--red); color:var(--red); background:transparent; }
  .mchips .hd { font-size:11px; color:var(--dim); letter-spacing:.14em; align-self:center;
               border:0; padding:0; margin-right:2px; cursor:default; }
  .mchips .hd:hover { color:var(--dim); }
  /* 技能 chips 选中态 */
  .skills label { border:1px solid var(--hair); padding:2px 10px; cursor:pointer;
                 transition:border-color .1s, background .1s; }
  .skills label.on { border-color:var(--red); color:var(--red); background:#F7EDE4; }
  .skills label.on::after { content:" ✓"; }
  /* 团卡片头部 */
  .panel-card { border-left:3px solid var(--red); }
  .panel-head .idx { background:var(--wash); padding:2px 8px; }
  .judge-head .jnum { font-size:11px; color:var(--dim); white-space:nowrap; }
  textarea.persona { min-height:52px; overflow:hidden; }
</style></head><body>
<main>
  <a class="home-link" href="/">← 返回投稿</a>
  <div class="dateline">评卷委员会配置 · 保存后投稿页即时生效</div>
  <div class="masthead"><h1>研<span class="dot">·</span>证</h1></div>
  <div class="eng">Committee Configuration</div>
  <div class="double"></div>

  <div class="section-label">审 稿 人（AI）</div>
  <label>厂 商 预 设（国内主流大模型）</label>
  <select id="llm_preset">
    <option value="deepseek">DeepSeek（深度求索 · 官方端点）</option>
    <option value="kimi">Kimi（月之暗面 Moonshot）</option>
    <option value="qwen">Qwen 通义千问（阿里云百炼）</option>
    <option value="glm">GLM（智谱 BigModel）</option>
    <option value="doubao">豆包（火山方舟 · 字节跳动）</option>
    <option value="ernie">文心一言（百度千帆）</option>
    <option value="hunyuan">混元（腾讯云）</option>
    <option value="spark">星火（讯飞开放平台）</option>
    <option value="minimax">MiniMax（海螺）</option>
    <option value="custom">自定义 OpenAI 兼容端点（如本地模型服务）</option>
  </select>
  <div class="cfg-grid">
    <div>
      <label>端 点 地 址（BASE URL）</label>
      <input type="url" id="llm_base_url" spellcheck="false">
    </div>
    <div>
      <label>API KEY（留空 = 保持已存值不变；清空后保存 = 切回演示模式）</label>
      <input type="password" id="llm_key" autocomplete="off" placeholder="">
    </div>
    <div>
      <label>评 卷 档 模 型（flash 档）</label>
      <input type="text" id="model_judge" list="model_judge_list" spellcheck="false">
      <datalist id="model_judge_list"></datalist>
    </div>
    <div>
      <label>仲 裁 档 模 型（pro 档）</label>
      <input type="text" id="model_arbiter" list="model_arbiter_list" spellcheck="false">
      <datalist id="model_arbiter_list"></datalist>
    </div>
  </div>
  <div class="row-btns">
    <button type="button" class="ghost" id="pull-models">从端点拉取模型列表</button>
    <span id="pull-status" class="subnote" style="align-self:center"></span>
  </div>
  <div class="mchips" id="judge-chips"></div>
  <div class="mchips" id="arbiter-chips" style="margin-bottom:4px"></div>
  <p class="subnote">评卷员默认走「评卷档」（非思考），团长与总仲裁走「仲裁档」（思考模式）。DeepSeek 的私有 thinking 参数按厂商自动适配，不会发给其他家端点。key 保存在本机服务端（data/rubric.json，不入 git）。</p>

  <div class="section-label">评 审 团 编 制</div>
  <p class="subnote" style="margin:0 0 6px">可增删评审团 / 评卷员，自定义名称、视角（persona）、技能与模型档；及格线随编制总分等比缩放。</p>
  <div id="panels"></div>
  <div class="cfg-actions">
    <button type="button" class="ghost" id="add-panel">＋ 添 加 评 审 团</button>
    <button type="button" class="ghost" id="reset-rubric">恢 复 默 认 编 制</button>
  </div>

  <div class="save-bar">
    <button type="button" id="save">保 存 配 置</button>
    <span id="save-status"></span>
  </div>
  <div class="back"><a href="/">← 返回投稿页</a></div>
</main>
<script id="skills-data" type="application/json">__SKILLS__</script>
<script id="panels-data" type="application/json">__PANELS__</script>
<script id="llm-data" type="application/json">__LLM__</script>
<script>
(function() {
  var SKILLS = JSON.parse(document.getElementById('skills-data').textContent);
  var state = JSON.parse(document.getElementById('panels-data').textContent);
  var savedLlm = JSON.parse(document.getElementById('llm-data').textContent);
  var DS = { base: '__DS_BASE__', judge: '__DS_JUDGE__', arbiter: '__DS_ARBITER__' };

  var PRESETS = {
    deepseek: {
      base: DS.base, thinking: 'deepseek',
      judge: [
        { id: DS.judge, label: 'DeepSeek-V4.1-Flash · 非思考 · 评卷推荐' },
        { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash · 轻量非思考' },
        { id: DS.arbiter, label: 'DeepSeek-V4-Pro · 思考（评卷档成本高）' }
      ],
      arbiter: [
        { id: DS.arbiter, label: 'DeepSeek-V4-Pro · 思考 · 仲裁推荐' },
        { id: DS.judge, label: 'DeepSeek-V4.1-Flash · 非思考（仲裁不建议）' }
      ]
    },
    kimi: {
      base: 'https://api.moonshot.cn/v1', thinking: 'off',
      judge: [
        { id: 'kimi-k2-turbo-preview', label: 'K2 Turbo · 快 · 评卷推荐' },
        { id: 'kimi-k2-0905-preview', label: 'K2 · 标准档' },
        { id: 'moonshot-v1-32k', label: 'Moonshot V1 (32K) · 长文本' }
      ],
      arbiter: [
        { id: 'kimi-k2-thinking', label: 'K2 Thinking · 思考 · 仲裁推荐' },
        { id: 'kimi-k2-0905-preview', label: 'K2 · 标准档' }
      ]
    },
    qwen: {
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinking: 'off',
      judge: [
        { id: 'qwen-flash', label: 'Qwen-Flash · 快 · 评卷推荐' },
        { id: 'qwen-plus', label: 'Qwen-Plus · 均衡' },
        { id: 'qwen-turbo', label: 'Qwen-Turbo · 最快最便宜' }
      ],
      arbiter: [
        { id: 'qwen3-max', label: 'Qwen3-Max · 旗舰 · 仲裁推荐' },
        { id: 'qwen-max', label: 'Qwen-Max · 上一代旗舰' }
      ]
    },
    glm: {
      base: 'https://open.bigmodel.cn/api/paas/v4', thinking: 'off',
      judge: [
        { id: 'glm-4.5-flash', label: 'GLM-4.5-Flash · 低价 · 评卷推荐' },
        { id: 'glm-4.5-air', label: 'GLM-4.5-Air · 轻量' },
        { id: 'glm-4-flash', label: 'GLM-4-Flash · 免费' }
      ],
      arbiter: [
        { id: 'glm-4.6', label: 'GLM-4.6 · 旗舰 · 仲裁推荐' },
        { id: 'glm-4-plus', label: 'GLM-4-Plus · 上一代旗舰' }
      ]
    },
    doubao: {
      base: 'https://ark.cn-beijing.volces.com/api/v3', thinking: 'off',
      judge: [
        { id: 'doubao-1-5-lite-32k-250115', label: 'Doubao-1.5-lite · 快 · 评卷推荐' },
        { id: 'doubao-1-5-pro-32k-250115', label: 'Doubao-1.5-pro · 均衡' }
      ],
      arbiter: [
        { id: 'doubao-1-5-thinking-pro-m-250428', label: 'Doubao-1.5 Thinking Pro · 思考 · 仲裁推荐' },
        { id: 'doubao-1-5-pro-256k-250115', label: 'Doubao-1.5-pro (256K) · 长文本' }
      ]
    },
    ernie: {
      base: 'https://qianfan.baidubce.com/v2', thinking: 'off',
      judge: [
        { id: 'ernie-4.0-8k-latest', label: 'ERNIE-4.0 · 评卷推荐' },
        { id: 'ernie-speed-8k', label: 'ERNIE-Speed · 快' },
        { id: 'ernie-lite-8k', label: 'ERNIE-Lite · 低价' }
      ],
      arbiter: [
        { id: 'ernie-4.5-turbo-128k', label: 'ERNIE-4.5 Turbo · 旗舰 · 仲裁推荐' },
        { id: 'ernie-4.0-8k-latest', label: 'ERNIE-4.0 · 轻量仲裁' }
      ]
    },
    hunyuan: {
      base: 'https://api.hunyuan.cloud.tencent.com/v1', thinking: 'off',
      judge: [
        { id: 'hunyuan-lite', label: 'Hunyuan-Lite · 免费 · 评卷推荐' },
        { id: 'hunyuan-standard', label: 'Hunyuan-Standard · 标准' }
      ],
      arbiter: [
        { id: 'hunyuan-turbos-20250416', label: 'Hunyuan-TurboS · 旗舰 · 仲裁推荐' },
        { id: 'hunyuan-t1-20250403', label: 'Hunyuan-T1 · 思考' }
      ]
    },
    spark: {
      base: 'https://spark-api-open.xf-yun.com/v1', thinking: 'off',
      judge: [
        { id: 'lite', label: 'Spark-Lite · 低价 · 评卷推荐' },
        { id: 'generalv3.5', label: 'Spark-Max (V3.5) · 均衡' }
      ],
      arbiter: [
        { id: '4.0Ultra', label: 'Spark-4.0 Ultra · 旗舰 · 仲裁推荐' },
        { id: 'generalv3.5', label: 'Spark-Max · 轻量仲裁' }
      ]
    },
    minimax: {
      base: 'https://api.minimaxi.com/v1', thinking: 'off',
      judge: [ { id: 'MiniMax-Text-01', label: 'MiniMax-Text-01 · 评卷档' } ],
      arbiter: [ { id: 'MiniMax-M2', label: 'MiniMax-M2 · 旗舰 · 仲裁推荐' } ]
    },
    custom: { base: '', thinking: 'deepseek', judge: [], arbiter: [] }
  };

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function fillDatalist(id, models) {
    var dl = document.getElementById(id);
    dl.innerHTML = '';
    models.forEach(function(m) {
      var o = document.createElement('option');
      o.value = m.id;
      if (m.label) o.label = m.label;
      dl.appendChild(o);
    });
  }
  // 型号速选 chips：点击直接填入对应档位输入框（比 datalist 在移动端更直观）
  function renderChips(containerId, inputId, models) {
    var box = document.getElementById(containerId);
    box.innerHTML = '';
    if (!models.length) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    var hd = document.createElement('span');
    hd.className = 'hd';
    hd.textContent = inputId === 'model_judge' ? '评卷档速选：' : '仲裁档速选：';
    box.appendChild(hd);
    models.slice(0, 4).forEach(function(m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.id;
      if (m.label) b.title = m.label;
      b.addEventListener('click', function() {
        document.getElementById(inputId).value = m.id;
      });
      box.appendChild(b);
    });
  }
  function renderAllChips(models) {
    renderChips('judge-chips', 'model_judge', models);
    renderChips('arbiter-chips', 'model_arbiter', models);
  }
  function applyCatalog(name) {
    var p = PRESETS[name] || { judge: [], arbiter: [], thinking: 'deepseek' };
    fillDatalist('model_judge_list', p.judge);
    fillDatalist('model_arbiter_list', p.arbiter);
    renderAllChips(p.judge);
  }
  function presetValue() { return document.getElementById('llm_preset').value; }

  function applyPreset(keepValues) {
    var p = PRESETS[presetValue()] || { base: '', judge: [], arbiter: [], thinking: 'deepseek' };
    var base = document.getElementById('llm_base_url');
    var mj = document.getElementById('model_judge');
    var ma = document.getElementById('model_arbiter');
    applyCatalog(presetValue());
    if (!keepValues) {
      base.value = p.base;
      mj.value = (p.judge[0] || {}).id || '';
      ma.value = (p.arbiter[0] || {}).id || '';
    }
    base.placeholder = p.base || 'http://127.0.0.1:11434/v1';
    var st = document.getElementById('pull-status');
    if (p.base) {
      st.textContent = '已填官方端点与推荐型号；目录若滞后于官方上新，可点「从端点拉取模型列表」或直接手输。';
    } else {
      st.textContent = '填好端点地址（公网）后点「从端点拉取模型列表」；本地端点不支持拉取，型号请手输。';
    }
  }
  document.getElementById('llm_preset').addEventListener('change', function() { applyPreset(false); });

  document.getElementById('pull-models').addEventListener('click', function() {
    var base = document.getElementById('llm_base_url').value.trim();
    var key = document.getElementById('llm_key').value.trim();
    var st = document.getElementById('pull-status');
    if (!base) { st.textContent = '请先填写端点地址'; return; }
    st.textContent = '拉取中…';
    fetch('/llm/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: base, key: key })
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(r) {
      if (!r.ok) { st.textContent = '拉取失败：' + (r.d.error || JSON.stringify(r.d)); return; }
      var ids = r.d.models || [];
      fillDatalist('model_judge_list', ids.map(function(x) { return { id: x }; }));
      fillDatalist('model_arbiter_list', ids.map(function(x) { return { id: x }; }));
      renderAllChips(ids.map(function(x) { return { id: x }; }));
      st.textContent = '已拉取 ' + ids.length + ' 个型号（两档共用该列表）。';
    }).catch(function(e) { st.textContent = '拉取失败：' + e; });
  });

  // ---------- 编制编辑器 ----------
  function sync() {}
  function skillBoxes(judge) {
    var box = el('div', 'skills');
    SKILLS.forEach(function(s) {
      var lb = el('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = judge.skills.indexOf(s.id) !== -1;
      lb.classList.toggle('on', cb.checked);
      cb.addEventListener('change', function() {
        if (cb.checked) { if (judge.skills.indexOf(s.id) === -1) judge.skills.push(s.id); }
        else { judge.skills = judge.skills.filter(function(x) { return x !== s.id; }); }
        lb.classList.toggle('on', cb.checked);
      });
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode(s.label));
      box.appendChild(lb);
    });
    return box;
  }
  function judgeCard(panel, judge, ji) {
    var card = el('div', 'judge-card');
    var head = el('div', 'judge-head');
    var name = document.createElement('input'); name.type = 'text'; name.className = 'jname';
    name.value = judge.name || '';
    name.addEventListener('input', function() { judge.name = name.value; });
    head.appendChild(name);
    var tier = document.createElement('select'); tier.className = 'tier';
    [['flash', '评卷档 flash'], ['pro', '仲裁档 pro']].forEach(function(t) {
      var o = document.createElement('option'); o.value = t[0]; o.textContent = t[1];
      tier.appendChild(o);
    });
    tier.value = judge.modelTier || 'flash';
    tier.addEventListener('change', function() { judge.modelTier = tier.value; });
    head.appendChild(tier);
    var del = el('button', 'ghost'); del.type = 'button'; del.textContent = '删除';
    del.addEventListener('click', function() {
      if (panel.judges.length <= 1) { alert('每团至少保留 1 名评卷员'); return; }
      panel.judges.splice(ji, 1); render();
    });
    head.appendChild(del);
    card.appendChild(head);
    var persona = document.createElement('textarea'); persona.className = 'judge-persona';
    persona.value = judge.persona || ''; persona.placeholder = '评卷视角（persona）：该评卷员只负责什么？重点看哪里？';
    persona.addEventListener('input', function() {
      judge.persona = persona.value;
      persona.style.height = 'auto';
      persona.style.height = Math.min(persona.scrollHeight, 200) + 'px';
    });
    card.appendChild(persona);
    card.appendChild(skillBoxes(judge));
    return card;
  }
  function panelCard(panel, pi) {
    var card = el('div', 'panel-card');
    var head = el('div', 'panel-head');
    var idx = el('span', 'idx'); idx.textContent = '第 ' + (pi + 1) + ' 团 · ' + panel.judges.length + ' 员';
    head.appendChild(idx);
    var name = document.createElement('input'); name.type = 'text'; name.className = 'pname';
    name.value = panel.name || '';
    name.addEventListener('input', function() { panel.name = name.value; });
    head.appendChild(name);
    var maxLbl = el('label', 'short'); maxLbl.textContent = '团满分';
    head.appendChild(maxLbl);
    var max = document.createElement('input'); max.type = 'number'; max.className = 'max';
    max.min = '1'; max.value = panel.maxScore;
    max.addEventListener('input', function() { panel.maxScore = Number(max.value) || panel.maxScore; });
    head.appendChild(max);
    var del = el('button', 'ghost'); del.type = 'button'; del.textContent = '删除本团';
    del.addEventListener('click', function() {
      if (state.length <= 1) { alert('至少保留 1 个评审团'); return; }
      state.splice(pi, 1); render();
    });
    head.appendChild(del);
    card.appendChild(head);
    panel.judges.forEach(function(j, ji) { card.appendChild(judgeCard(panel, j, ji)); });
    var row = el('div', 'row-btns');
    var add = el('button', 'ghost'); add.type = 'button'; add.textContent = '＋ 添加评卷员';
    add.addEventListener('click', function() {
      panel.judges.push({ name: '评卷员' + (panel.judges.length + 1), persona: '', skills: [], modelTier: 'flash' });
      render();
    });
    row.appendChild(add);
    card.appendChild(row);
    return card;
  }
  function render() {
    var root = document.getElementById('panels');
    root.innerHTML = '';
    state.forEach(function(p, pi) { root.appendChild(panelCard(p, pi)); });
  }
  document.getElementById('add-panel').addEventListener('click', function() {
    state.push({ name: '新评审团', maxScore: 20, weightHint: '',
      judges: [{ name: '评卷员1', persona: '', skills: [], modelTier: 'flash' }] });
    render();
  });
  document.getElementById('reset-rubric').addEventListener('click', function() {
    // 恢复为服务端保存的编制（非全局默认）；要全局默认可清 data/rubric.json
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { keep: true }, panels: null }) })
      .then(function() { return fetch('/config'); })
      .then(function(r) { location.reload(); });
  });

  // ---------- 保存 ----------
  document.getElementById('save').addEventListener('click', function() {
    var st = document.getElementById('save-status');
    var keyInput = document.getElementById('llm_key').value;
    if (keyInput === '清空' && !confirm('确定要清除已保存的 API KEY 吗？清除后将回到演示模式。')) return;
    var body = {
      llm: {
        preset: presetValue(),
        baseUrl: document.getElementById('llm_base_url').value.trim(),
        modelJudge: document.getElementById('model_judge').value.trim(),
        modelArbiter: document.getElementById('model_arbiter').value.trim(),
        thinkingStyle: (PRESETS[presetValue()] || {}).thinking || 'deepseek'
      },
      panels: state
    };
    // key 语义：留空 = 保持已存值；输入"清空"两个字 = 清除；其余 = 新 key
    if (keyInput === '清空') body.llm.apiKey = null;
    else if (keyInput !== '') body.llm.apiKey = keyInput;
    // 未触碰（占位文案）或留空 → 不带 apiKey 字段 = 服务端保留原值

    var btn = document.getElementById('save');
    btn.disabled = true;
    st.className = ''; st.textContent = '保存中…';
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
      .then(function(r) {
        btn.disabled = false;
        if (r.ok) {
          st.className = 'ok';
          st.innerHTML = '已保存：' + r.d.panels + ' 团 ' + r.d.judges + ' 员 —— 投稿页即时生效 · <a href="/">去投稿 →</a>';
        } else {
          st.className = 'err';
          st.textContent = '保存失败：' + (r.d.error || JSON.stringify(r.d));
        }
      })
      .catch(function(e) { btn.disabled = false; st.className = 'err'; st.textContent = '保存失败：' + e; });
  });

  // ---------- 初始化（读取服务端已保存值） ----------
  document.getElementById('llm_preset').value = savedLlm.preset || 'deepseek';
  document.getElementById('llm_base_url').value = savedLlm.baseUrl || '';
  document.getElementById('model_judge').value = savedLlm.modelJudge || '';
  document.getElementById('model_arbiter').value = savedLlm.modelArbiter || '';
  document.getElementById('llm_key').placeholder = savedLlm.apiKey || 'sk-...（留空保持不变）';
  applyCatalog(savedLlm.preset || 'deepseek');
  render();
})();
</script>
</body></html>`
