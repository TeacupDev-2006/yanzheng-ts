/**
 * 研证 Web 形态：上传论文 → 评卷 → 单文件 HTML 报告（Hono，对照 yanzheng/web/app.py 扩展）。
 *
 * 相比原版的增强（评卷委员会配置器）：
 * - 自选 AI：预设/自定义 OpenAI 兼容端点 + 用户自己的 API key + 评卷/仲裁双档模型名
 * - 自定义评审团编制：可增删评审团、增删评卷员、编辑名称/视角（persona）、
 *   每员可勾选确定性 skill、选择模型档（flash=评卷档 / pro=仲裁档）
 * - 不填 key 自动进入演示模式（确定性 mock）
 *
 * 端点：
 *   GET  /        投稿页 + 评卷委员会配置器（移动端适配）
 *   POST /review  multipart 文件 + 选项 → 评卷 → 直接返回 HTML 报告
 *   GET  /health  健康检查
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

  /** 拉取用户自备端点的模型清单（与评卷调用同一端点路径，scheme 校验一致）。 */
  app.post('/llm/models', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: string; key?: string } | null
    const url = String(body?.url ?? '').trim()
    if (!url) return c.json({ error: '缺少端点地址' }, 400)
    if (!/^https?:\/\//.test(url.trim())) {
      return c.json({ error: '端点仅允许 http/https' }, 400)
    }
    try {
      const models = await listModels({ baseUrl: url, apiKey: body?.key || null })
      return c.json({ models })
    } catch (exc) {
      return c.json({ error: exc instanceof Error ? exc.message : String(exc) }, 502)
    }
  })

  app.get('/', (c) => {
    const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
    const demoBadge = hasKey
      ? '<span class="badge ink">真实评卷 · 评卷团已就位</span>'
      : '<span class="badge">演示模式 · 未配置审稿人（结果为确定性 mock）</span>'
    const safe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
    return c.html(
      INDEX_HTML.replace('<!--BADGE-->', () => demoBadge)
        .replaceAll('__SKILLS__', () => safe(AVAILABLE_SKILLS))
        .replaceAll('__RUBRIC__', () => safe(ALL_PANELS))
        .replaceAll('__DS_BASE__', () => DEEPSEEK_BASE)
        .replaceAll('__DS_JUDGE__', () => DEEPSEEK_JUDGE_MODEL)
        .replaceAll('__DS_ARBITER__', () => DEEPSEEK_ARBITER_MODEL),
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

    // 自定义评审团编制（可选；缺省为标准 4 团 13 员）
    let panels: PanelSpec[] | undefined
    const rubricRaw = String(form.rubric_json ?? '').trim()
    if (rubricRaw) {
      try {
        panels = normalizePanels(JSON.parse(rubricRaw))
      } catch (exc) {
        return c.text(`评审团配置无效：${exc instanceof Error ? exc.message : String(exc)}`, 400)
      }
    }

    // 自选 AI（可选；key 留空 = 演示模式确定性 mock）
    const apiKey = String(form.llm_key ?? '').trim() || null
    const baseUrl = String(form.llm_base_url ?? '').trim() || undefined
    const modelFlash = String(form.model_judge ?? '').trim() || undefined
    const modelPro = String(form.model_arbiter ?? '').trim() || undefined
    // 思考开关风格由预设决定（第三方端点不携带 DeepSeek 私有 thinking 字段）
    const thinkingStyle = String(form.llm_thinking ?? '') === 'off' ? ('off' as const) : ('deepseek' as const)

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
        panels,
        baseUrl,
        modelFlash,
        modelPro,
        thinkingStyle,
      })
      return c.html(renderHtml(report))
    } catch (exc) {
      return c.text(`评卷失败：${exc instanceof Error ? exc.message : String(exc)}`, 502)
    }
  })

  return app
}

/** pdf 上传时内存抽取文本（unpdf）。 */
async function pdfTextOf(data: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(data))
  const { text } = await extractText(pdf, { mergePages: true })
  return (Array.isArray(text) ? text.join('\n') : text) ?? ''
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>研证 · 评卷纪要</title>
<style>
  :root { --paper:#FAF6EE; --ink:#1c1a17; --red:#A63D2F; --hair:#D9D2C2; --dim:#6E675B; --wash:#F3EDE0; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin:0; background:var(--paper); color:var(--ink);
        font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
        line-height:1.7; }
  .spine { position:fixed; right:26px; top:50%; transform:translateY(-50%);
          writing-mode:vertical-rl; letter-spacing:.5em; font-size:12px; color:var(--dim);
          border-left:1px solid var(--hair); padding-left:10px; user-select:none; }
  @media (max-width: 900px) { .spine { display:none; } }
  main { max-width: 680px; margin: 0 auto; padding: 28px 18px 60px; }
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
         margin:0 0 26px; }
  .badge { display:inline-block; font-size:12px; letter-spacing:.12em; color:var(--red);
          border:1px solid var(--red); padding:2px 12px; margin-bottom:24px; }
  .badge.ink { color:var(--ink); border-color:var(--ink); }
  .section-label { text-align:center; font-size:12px; letter-spacing:.4em; color:var(--red);
                  margin: 26px 0 14px; }
  form { border-top:1px solid var(--hair); padding-top:8px; }
  .drop { border:1px solid var(--hair); background:#FFFDF8; padding:30px 16px;
         text-align:center; color:var(--dim); font-size:14px; margin-bottom:20px; }
  .drop b { color:var(--ink); }
  input[type=file] { width:100%; margin-top:10px; font-family:inherit; }
  label { display:block; font-size:13px; letter-spacing:.18em; color:var(--dim);
         margin:18px 0 6px; }
  input[type=number], input[type=text], input[type=password], input[type=url], textarea, select {
        width:100%; padding:8px 6px; border:1px solid var(--hair); background:#FFFDF8;
        font:inherit; font-size:14px; border-radius:0; }
  input:focus, textarea:focus, select:focus { outline:none; border-color:var(--red); }
  textarea { resize:vertical; }
  .check { display:flex; align-items:baseline; gap:8px; margin-top:18px; font-size:14px; }
  .check input { width:auto; accent-color: var(--red); }
  button { padding:8px 14px; background:var(--ink); color:var(--paper);
          border:0; font:inherit; font-size:13px; letter-spacing:.2em; cursor:pointer; }
  button:hover { background:var(--red); }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--hair); }
  button.ghost:hover { border-color:var(--red); color:var(--red); background:transparent; }
  button:disabled { opacity:.55; cursor:wait; }
  .note { font-size:12.5px; color:var(--dim); margin-top:16px; text-align:center;
         font-style:italic; }
  .rule { border:0; border-top:1px solid var(--hair); margin:30px 0 0; }
  .colophon { text-align:center; font-size:11.5px; color:var(--dim); margin-top:14px;
             letter-spacing:.1em; }
  .stamp { display:inline-block; margin-top:18px; border:2.5px solid var(--red); color:var(--red);
          font-size:30px; font-weight:900; padding:6px 14px; letter-spacing:.2em;
          transform:rotate(-7deg); border-radius:4px; opacity:.85; }
  /* ---- 配置器 ---- */
  .cfg-grid { display:grid; grid-template-columns:1fr 1fr; gap:0 14px; }
  @media (max-width:560px) { .cfg-grid { grid-template-columns:1fr; } }
  .panel-card { border:1px solid var(--hair); background:#FFFDF8; padding:12px 12px 10px; margin:12px 0; }
  .panel-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .panel-head .idx { font-size:12px; letter-spacing:.2em; color:var(--red); white-space:nowrap; }
  .panel-head input.name { flex:1 1 160px; }
  .panel-head input.max { width:92px; }
  .panel-head label.short { margin:0; font-size:11px; white-space:nowrap; }
  .judge-card { border:1px dotted var(--hair); padding:10px; margin:10px 0 0; }
  .judge-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .judge-head input.name { flex:1 1 130px; }
  .judge-head select.tier { width:110px; }
  .judge-persona { margin-top:8px; font-size:13px; min-height:52px; }
  .skills { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; font-size:12.5px; }
  .skills label { margin:0; letter-spacing:.02em; display:flex; gap:4px; align-items:baseline; color:var(--ink); }
  .skills input { accent-color:var(--red); }
  .row-btns { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .cfg-actions { display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; justify-content:center; }
  .subnote { font-size:12px; color:var(--dim); margin:6px 0 0; }
</style></head><body>
<div class="spine">毕业论文评卷纪要 · 全一册</div>
<main>
  <div class="dateline">第 一 期 · 二〇二六年十月 · 毕业论文评卷特辑</div>
  <div class="masthead"><h1>研<span class="dot">·</span>证</h1></div>
  <div class="eng">Yanzheng — The Thesis Review</div>
  <div class="double"></div>
  <p class="lede">四团十三员，各凭证据独立执笔；分差则仲裁，作假者否决。——本刊评卷章程</p>
  <div style="text-align:center"><!--BADGE--></div>

  <form id="cfg" action="/review" method="post" enctype="multipart/form-data">
    <input type="hidden" name="rubric_json" id="rubric_json">
    <input type="hidden" name="llm_thinking" id="llm_thinking" value="deepseek">

    <div class="section-label">评 卷 委 员 会 配 置</div>

    <label>审 稿 人（AI）· 预 设</label>
    <select id="llm_preset">
      <option value="deepseek">DeepSeek（官方端点 · 双档型号）</option>
      <option value="openai">OpenAI（GPT 系列 · OpenAI 兼容）</option>
      <option value="anthropic">Anthropic（Claude 系列 · OpenAI 兼容层）</option>
      <option value="gemini">Google Gemini（OpenAI 兼容层）</option>
      <option value="kimi">Kimi（月之暗面 Moonshot）</option>
      <option value="qwen">Qwen（阿里云百炼 · OpenAI 兼容）</option>
      <option value="glm">GLM（智谱 BigModel）</option>
      <option value="xai">xAI（Grok 系列）</option>
      <option value="minimax">MiniMax</option>
      <option value="openrouter">OpenRouter（聚合 · 可拉取数百型号）</option>
      <option value="agnes">Agnes 赛事端点（自行填写地址与型号）</option>
      <option value="custom">自定义 OpenAI 兼容端点（如本地模型服务）</option>
    </select>
    <div class="cfg-grid">
      <div>
        <label>端 点 地 址（BASE URL）</label>
        <input type="url" name="llm_base_url" id="llm_base_url" placeholder="__DS_BASE__" spellcheck="false">
      </div>
      <div>
        <label>API KEY（留空 = 演示模式）</label>
        <input type="password" name="llm_key" id="llm_key" autocomplete="off" placeholder="sk-...">
      </div>
      <div>
        <label>评 卷 档 模 型（flash 档）</label>
        <input type="text" name="model_judge" id="model_judge" list="model_judge_list" placeholder="__DS_JUDGE__" spellcheck="false">
        <datalist id="model_judge_list"></datalist>
      </div>
      <div>
        <label>仲 裁 档 模 型（pro 档）</label>
        <input type="text" name="model_arbiter" id="model_arbiter" list="model_arbiter_list" placeholder="__DS_ARBITER__" spellcheck="false">
        <datalist id="model_arbiter_list"></datalist>
      </div>
    </div>
    <div class="row-btns">
      <button type="button" class="ghost" id="pull-models">从端点拉取模型列表</button>
      <span id="pull-status" class="subnote" style="align-self:center">DeepSeek 预设已内置现行型号目录；其他公网端点填好地址（和 key）后点此拉取真实型号（本地/内网端点不提供拉取，型号请手输）。</span>
    </div>
    <p class="subnote">评卷员默认走「评卷档」（非思考），团长与总仲裁走「仲裁档」（思考模式）。任何 OpenAI 兼容端点均可，本地服务（http://127.0.0.1:...）亦可；模型可从下拉选择，也可直接输入任意型号。</p>

    <label style="margin-top:24px">评 审 团 编 制（可增删评审团 / 评卷员，可自定义视角与技能）</label>
    <div id="panels"></div>
    <div class="cfg-actions">
      <button type="button" class="ghost" id="add-panel">＋ 添 加 评 审 团</button>
      <button type="button" class="ghost" id="reset-rubric">恢 复 默 认 编 制</button>
    </div>
    <p class="subnote">每团满分、团数、员数均由您定；及格线（总分 60%）与等级分档随编制总分等比缩放。留空视角（persona）时自动按团名生成。</p>

    <div class="section-label">投 稿</div>
    <div class="drop">本刊受理 <b>.pdf / .txt / .md</b> 稿件，篇幅以 20MB 为限
      <input type="file" name="file" accept=".pdf,.txt,.md" required>
    </div>
    <label>门 检 最 低 字 数</label>
    <input type="number" name="min_words" value="10000" min="0">
    <div class="check"><input type="checkbox" name="online" value="1" id="online">
      <label for="online" style="margin:0;letter-spacing:.05em">启用在线核查（Crossref 验引用 · OpenAlex 检文献）</label></div>
    <button type="submit" id="go" style="width:100%;margin-top:26px;padding:14px;font-size:17px;letter-spacing:.5em;text-indent:.5em">送 申 评 卷</button>
    <p class="note">评卷时长取决于编制规模与模型档位：评卷员并行独立打分，其后两级仲裁复核。请勿离席。</p>
  </form>

  <hr class="rule">
  <div class="colophon">内容审题四十 · 结构逻辑三十 · 语言表达十五 · 规范核查十五<br>
  查重不过者打回 · 作假成立者一票否决</div>
  <div style="text-align:center"><span class="stamp">阅</span></div>
</main>
<script id="skills-data" type="application/json">__SKILLS__</script>
<script id="rubric-data" type="application/json">__RUBRIC__</script>
<script>
(function() {
  var SKILLS = JSON.parse(document.getElementById('skills-data').textContent);
  var DEFAULT_RUBRIC = JSON.parse(document.getElementById('rubric-data').textContent);
  var state = JSON.parse(JSON.stringify(DEFAULT_RUBRIC));
  var DS = { base: '__DS_BASE__', judge: '__DS_JUDGE__', arbiter: '__DS_ARBITER__' };

  // 具体型号目录：按厂商预设（评卷档=快/便宜，仲裁档=旗舰/思考）。
  // 目录为常用清单，可能滞后于官方上新——可随时「从端点拉取」或直接手输任意型号。
  // thinking 字段为 DeepSeek V4 私有语义：仅 deepseek/agnes/custom 预设随请求携带，
  // 其余第三方端点会因未知参数报 400（详见 core llm/client.ts 的 thinkingStyle）。
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
    openai: {
      base: 'https://api.openai.com/v1', thinking: 'off',
      judge: [
        { id: 'gpt-5-mini', label: 'GPT-5 mini · 高性价比 · 评卷推荐' },
        { id: 'gpt-5-nano', label: 'GPT-5 nano · 最快最便宜' },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini · 非思考' }
      ],
      arbiter: [
        { id: 'gpt-5', label: 'GPT-5 · 旗舰 · 仲裁推荐' },
        { id: 'gpt-5-mini', label: 'GPT-5 mini · 轻量仲裁' }
      ]
    },
    anthropic: {
      base: 'https://api.anthropic.com/v1', thinking: 'off',
      judge: [
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5 · 快 · 评卷推荐' },
        { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5 · 均衡' }
      ],
      arbiter: [
        { id: 'claude-opus-4-1', label: 'Opus 4.1 · 旗舰 · 仲裁推荐' },
        { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5 · 轻量仲裁' }
      ]
    },
    gemini: {
      base: 'https://generativelanguage.googleapis.com/v1beta/openai', thinking: 'off',
      judge: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · 评卷推荐' },
        { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · 最快最便宜' }
      ],
      arbiter: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · 仲裁推荐' }
      ]
    },
    kimi: {
      base: 'https://api.moonshot.cn/v1', thinking: 'off',
      judge: [
        { id: 'kimi-k2-turbo-preview', label: 'K2 Turbo · 快 · 评卷推荐' },
        { id: 'kimi-k2-0905-preview', label: 'K2 · 标准档' }
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
        { id: 'qwen-plus', label: 'Qwen-Plus · 均衡' }
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
        { id: 'glm-4.5-air', label: 'GLM-4.5-Air · 轻量' }
      ],
      arbiter: [
        { id: 'glm-4.6', label: 'GLM-4.6 · 旗舰 · 仲裁推荐' },
        { id: 'glm-4.5', label: 'GLM-4.5 · 上一代旗舰' }
      ]
    },
    xai: {
      base: 'https://api.x.ai/v1', thinking: 'off',
      judge: [
        { id: 'grok-4-fast', label: 'Grok-4 Fast · 非思考 · 评卷推荐' },
        { id: 'grok-3-mini', label: 'Grok-3 mini · 轻量' }
      ],
      arbiter: [
        { id: 'grok-4', label: 'Grok-4 · 旗舰 · 仲裁推荐' },
        { id: 'grok-4-fast-reasoning', label: 'Grok-4 Fast (Reasoning) · 轻量仲裁' }
      ]
    },
    minimax: {
      base: 'https://api.minimaxi.com/v1', thinking: 'off',
      judge: [
        { id: 'MiniMax-Text-01', label: 'MiniMax-Text-01 · 评卷档' }
      ],
      arbiter: [
        { id: 'MiniMax-M2', label: 'MiniMax-M2 · 旗舰 · 仲裁推荐' }
      ]
    },
    openrouter: {
      base: 'https://openrouter.ai/api/v1', thinking: 'off',
      judge: [],
      arbiter: []
    },
    agnes: { base: '', thinking: 'deepseek', judge: [], arbiter: [] },
    custom: { base: '', thinking: 'deepseek', judge: [], arbiter: [] }
  };
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
  function applyCatalog(name) {
    var p = PRESETS[name] || { judge: [], arbiter: [], thinking: 'deepseek' };
    fillDatalist('model_judge_list', p.judge);
    fillDatalist('model_arbiter_list', p.arbiter);
    document.getElementById('llm_thinking').value = p.thinking;
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function labeled(parent, text, input) {
    var lb = el('label'); lb.textContent = text; lb.style.margin = '6px 0 2px';
    parent.appendChild(lb); parent.appendChild(input); return input;
  }
  function sync() {
    document.getElementById('rubric_json').value = JSON.stringify(state);
  }
  function skillBoxes(judge) {
    var box = el('div', 'skills');
    SKILLS.forEach(function(s) {
      var lb = el('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = judge.skills.indexOf(s.id) !== -1;
      cb.addEventListener('change', function() {
        if (cb.checked) { if (judge.skills.indexOf(s.id) === -1) judge.skills.push(s.id); }
        else { judge.skills = judge.skills.filter(function(x) { return x !== s.id; }); }
        sync();
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
    var name = document.createElement('input'); name.type = 'text'; name.className = 'name';
    name.value = judge.name; name.placeholder = '评卷员名称';
    name.addEventListener('input', function() { judge.name = name.value; sync(); });
    head.appendChild(name);
    var tier = document.createElement('select'); tier.className = 'tier';
    [['flash', '评卷档 flash'], ['pro', '仲裁档 pro']].forEach(function(t) {
      var o = document.createElement('option'); o.value = t[0]; o.textContent = t[1];
      tier.appendChild(o);
    });
    tier.value = judge.modelTier || 'flash';
    tier.addEventListener('change', function() { judge.modelTier = tier.value; sync(); });
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
    persona.addEventListener('input', function() { judge.persona = persona.value; sync(); });
    card.appendChild(persona);
    card.appendChild(skillBoxes(judge));
    return card;
  }
  function panelCard(panel, pi) {
    var card = el('div', 'panel-card');
    var head = el('div', 'panel-head');
    var idx = el('span', 'idx'); idx.textContent = '第 ' + (pi + 1) + ' 团 · ' + panel.judges.length + ' 员';
    head.appendChild(idx);
    var name = document.createElement('input'); name.type = 'text'; name.className = 'name';
    name.value = panel.name; name.placeholder = '评审团名称';
    name.addEventListener('input', function() { panel.name = name.value; sync(); });
    head.appendChild(name);
    var maxLbl = el('label', 'short'); maxLbl.textContent = '团满分';
    head.appendChild(maxLbl);
    var max = document.createElement('input'); max.type = 'number'; max.className = 'max';
    max.min = '1'; max.value = panel.maxScore;
    max.addEventListener('input', function() { panel.maxScore = Number(max.value) || panel.maxScore; sync(); });
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
    sync();
  }
  document.getElementById('add-panel').addEventListener('click', function() {
    state.push({ name: '新评审团', maxScore: 20, weightHint: '',
      judges: [{ name: '评卷员1', persona: '', skills: [], modelTier: 'flash' }] });
    render();
  });
  document.getElementById('reset-rubric').addEventListener('click', function() {
    state = JSON.parse(JSON.stringify(DEFAULT_RUBRIC)); render();
  });
  var preset = document.getElementById('llm_preset');
  function applyPreset() {
    var p = PRESETS[preset.value] || { base: '', judge: [], arbiter: [], thinking: 'deepseek' };
    var base = document.getElementById('llm_base_url');
    var mj = document.getElementById('model_judge');
    var ma = document.getElementById('model_arbiter');
    applyCatalog(preset.value);
    base.value = p.base; mj.value = (p.judge[0] || {}).id || ''; ma.value = (p.arbiter[0] || {}).id || '';
    base.placeholder = p.base || (preset.value === 'agnes' ? 'https://<agnes-openai-兼容端点>' : 'http://127.0.0.1:11434/v1');
    mj.placeholder = '评卷档模型名（可下拉选或拉取）'; ma.placeholder = '仲裁档模型名（可下拉选或拉取）';
    var st = document.getElementById('pull-status');
    if (preset.value === 'openrouter') {
      st.textContent = 'OpenRouter 聚合数百个型号：填好 key 后点「从端点拉取模型列表」选择；也可手输如 openai/gpt-5、anthropic/claude-sonnet-4-5。';
    } else if (p.base) {
      st.textContent = '已填官方端点与推荐型号；型号目录若滞后于官方上新，可点「从端点拉取模型列表」或直接手输。';
    } else {
      st.textContent = '填好端点地址（和 key）后点「从端点拉取模型列表」，即可从下拉选择真实型号。';
    }
  }
  preset.addEventListener('change', applyPreset);
  document.getElementById('pull-models').addEventListener('click', function() {
    var base = document.getElementById('llm_base_url').value.trim();
    var key = document.getElementById('llm_key').value;
    var st = document.getElementById('pull-status');
    if (!base) { st.textContent = '请先填写端点地址'; return; }
    st.textContent = '拉取中…';
    fetch('/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: base, key: key })
    }).then(function(r) {
      return r.json().then(function(d) { return { ok: r.ok, d: d }; });
    }).then(function(r) {
      if (!r.ok) { st.textContent = '拉取失败：' + (r.d.error || JSON.stringify(r.d)); return; }
      var ids = r.d.models || [];
      fillDatalist('model_judge_list', ids.map(function(x) { return { id: x }; }));
      fillDatalist('model_arbiter_list', ids.map(function(x) { return { id: x }; }));
      st.textContent = '已拉取 ' + ids.length + ' 个型号（两档共用该列表；直接在输入框点击即可下拉选择，也可手输任意型号）';
    }).catch(function(e) {
      st.textContent = '拉取失败：' + e;
    });
  });
  document.getElementById('cfg').addEventListener('submit', function() {
    sync();
    var b = document.getElementById('go');
    b.disabled = true; b.textContent = '评 卷 中 · 请 候';
  });
  render();
  applyPreset();
})();
</script>
</body></html>`
