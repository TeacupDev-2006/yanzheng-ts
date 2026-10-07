/**
 * 单文件 HTML 交互报告（文学期刊风）：报头 + 总分章 + 雷达 + 扣分清单 + 作假专区 + 回放。
 * 对照 yanzheng/reports/html_report.py 逐段移植（内联 CSS/JS，零外部依赖）。
 * 视觉：编辑部气质——宋体标题、米白纸面、细规矩线、朱红批注与「阅/否决」章。
 */

import type { GateResult, ReviewReport } from '../models.js'
import { gradeOf } from '../rubric.js'

const SEV_COLOR: Record<string, string> = { 轻微: '#8A6A22', 较重: '#A63D2F', 严重: '#7C1D1D' }

/** Python html.escape（quote=True）等价。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/** Python f"{x}" 对 float 的显示（24 → "24.0"，24.35 → "24.35"）。 */
function pyFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n)
}

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const CSS = `
  :root { --paper:#FAF6EE; --ink:#1c1a17; --red:#A63D2F; --hair:#D9D2C2; --dim:#6E675B;
          --wash:#F3EDE0; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--paper); color:var(--ink); line-height:1.75;
        font-family: Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC",
                     "SimSun", serif; overflow-wrap:break-word; }
  main { max-width:860px; margin:0 auto; padding:26px 18px 64px; }
  .dateline { text-align:center; font-size:12px; letter-spacing:.28em; color:var(--dim);
             border-bottom:1px solid var(--ink); padding-bottom:8px; }
  .masthead { text-align:center; padding:24px 0 8px; }
  .masthead h1 { margin:0; font-size:clamp(44px,10vw,58px); font-weight:900; letter-spacing:.08em; }
  .masthead h1 .dot { color:var(--red); }
  .eng { text-align:center; font-size:11px; letter-spacing:.5em; color:var(--dim);
        text-transform:uppercase; margin:6px 0 16px; }
  .double { border-top:3px solid var(--ink); border-bottom:1px solid var(--ink);
           height:5px; margin:0 0 20px; }
  .kicker { font-size:11px; letter-spacing:.42em; color:var(--red); margin:0 0 4px; }
  .headline { text-align:center; font-size:clamp(19px,4.4vw,25px); font-weight:900;
             line-height:1.5; margin:16px 0 4px; }
  .byline { text-align:center; font-size:13px; color:var(--dim); font-style:italic; margin:0; }
  .byline i { color:var(--red); }
  section { border-top:1px solid var(--hair); margin:30px 0 0; padding-top:14px; }
  h2 { font-size:clamp(16px,4vw,19px); font-weight:900; margin:2px 0 12px; }
  h2 .score { color:var(--red); font-variant-numeric:tabular-nums; }
  h2 .of { color:var(--dim); font-weight:400; font-size:14px; }
  h3 { font-size:14px; letter-spacing:.2em; color:var(--dim); font-weight:700;
      margin:16px 0 6px; }
  .scorecard { display:flex; flex-wrap:wrap; gap:12px 26px; align-items:center;
              justify-content:center; text-align:center; padding:16px 0 4px; }
  .total .num { font-size:clamp(52px,14vw,76px); font-weight:900; line-height:1.1;
               font-variant-numeric:tabular-nums; }
  .total .grade { color:var(--dim); letter-spacing:.14em; font-size:14px; }
  .stamp { display:inline-block; border:3px solid var(--ink); color:var(--ink);
          font-size:26px; font-weight:900; letter-spacing:.22em; text-indent:.22em;
          padding:6px 16px; border-radius:5px; transform:rotate(-7deg); opacity:.88; }
  .stamp.red { border-color:var(--red); color:var(--red); }
  .radar { flex:1 1 280px; text-align:center; min-width:0; }
  .radar canvas { max-width:100%; }
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  table { width:100%; border-collapse:collapse; font-size:13px; min-width:560px; }
  th { font-size:11.5px; letter-spacing:.18em; color:var(--dim); font-weight:700;
      border-top:2px solid var(--ink); border-bottom:1px solid var(--hair);
      background:var(--wash); padding:7px 9px; text-align:left; white-space:nowrap; }
  td { border-bottom:1px solid var(--hair); padding:7px 9px; vertical-align:top; }
  tr:last-child td { border-bottom:1px solid var(--ink); }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .sev { display:inline-block; border:1px solid; font-size:12px; padding:0 7px;
        white-space:nowrap; letter-spacing:.08em; }
  details { margin:8px 0; border:1px solid var(--hair); background:#FFFDF8; }
  summary { cursor:pointer; min-height:44px; padding:10px 12px; display:flex;
           align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
           font-weight:700; }
  summary:active { background:var(--wash); }
  .jsum { font-weight:400; color:var(--dim); font-size:12.5px; font-variant-numeric:tabular-nums; }
  .jsum b { color:var(--ink); font-variant-numeric:tabular-nums; }
  .conf-low { color:var(--red); font-weight:700; }
  details > .table-wrap { margin:0 10px 10px; }
  .arb, .replay { margin:4px 0; padding-left:18px; font-size:13px; }
  .arb li, .replay li { margin:5px 0; }
  .muted { color:var(--dim); font-size:12.5px; }
  .note { font-style:italic; }
  code { background:var(--wash); border:1px solid var(--hair); border-radius:2px;
        padding:0 5px; font-size:12px; }
  .fraud-mark { border-top:3px double var(--red); }
  .veto { margin-top:12px; display:flex; gap:14px; align-items:center; flex-wrap:wrap;
         border:1.5px solid var(--red); background:#F7EDE4; padding:12px 14px; }
  .veto .stamp { font-size:20px; padding:4px 12px; }
  .veto ul { margin:4px 0 0; padding-left:18px; font-weight:400; }
  .gate-warn { border-top:1px solid var(--hair); margin-top:26px; padding-top:12px; }
  .gate-warn ul { margin:6px 0 0; padding-left:20px; font-size:13.5px; }
  .replay li { list-style:none; }
  .replay { list-style:none; padding-left:0; }
  .replay li { padding:6px 2px; border-bottom:1px dotted var(--hair); }
  .replay li:last-child { border-bottom:0; }
  .colophon { text-align:center; border-top:1px solid var(--ink); margin-top:34px;
             padding-top:12px; font-size:11.5px; letter-spacing:.12em; color:var(--dim); }
  .colophon .usage { margin-top:4px; letter-spacing:.04em; }
  @media (max-width:560px) {
    main { padding:20px 12px 48px; }
    .total { width:100%; }
    table { font-size:12px; min-width:500px; }
    th, td { padding:5px 6px; }
    .stamp { font-size:22px; }
  }
  @media print {
    body { background:#fff; }
    section { break-inside:avoid; }
    details { border:0; }
    summary { min-height:0; }
  }
`

const JS = `
(function() {
  var data = JSON.parse(document.getElementById('radar-data').textContent);
  var cv = document.getElementById('radar');
  function drawRadar() {
    var w = cv.parentElement.clientWidth || 320;
    var size = Math.max(230, Math.min(360, w));
    var dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr; cv.height = size * dpr;
    cv.style.width = size + 'px'; cv.style.height = size + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cx = size / 2, cy = size / 2, R = size * 0.34, n = data.length;
    var small = size < 300;
    ctx.font = (small ? '11px ' : '13px ') + 'Georgia, "Noto Serif SC", "SimSun", serif';
    var labelR = R + (small ? 20 : 26);
    function ang(i) { return -Math.PI / 2 + i * 2 * Math.PI / n; }
    ctx.strokeStyle = '#D9D2C2';
    for (var ring = 1; ring <= 4; ring++) {
      ctx.beginPath();
      for (var i = 0; i <= n; i++) {
        var r = R * ring / 4, a = ang(i % n);
        i ? ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
          : ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#6E675B'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < n; i++) {
      var a = ang(i);
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); ctx.stroke();
      ctx.fillText(data[i].name, cx + labelR * Math.cos(a), cy + labelR * Math.sin(a) - (small ? 6 : 7));
      ctx.fillText(data[i].score + '/' + data[i].max,
                   cx + labelR * Math.cos(a), cy + labelR * Math.sin(a) + (small ? 7 : 8));
    }
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var d = data[i % n], a = ang(i), r = R * d.score / d.max;
      i ? ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
        : ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(166,61,47,.16)'; ctx.fill();
    ctx.strokeStyle = '#A63D2F'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1;
  }
  drawRadar();
  var tid = null;
  window.addEventListener('resize', function() {
    clearTimeout(tid); tid = setTimeout(drawRadar, 120);
  });
})();
`

function sevChip(sev: string): string {
  const color = SEV_COLOR[sev] ?? '#6E675B'
  return `<span class='sev' style='color:${color};border-color:${color}'>${esc(sev)}</span>`
}

function usageLine(report: ReviewReport): string {
  const models = report.usageSummary?.models ?? {}
  const names = Object.keys(models).sort()
  if (names.length === 0) return ''
  const parts = names.map((m) => {
    const u = models[m]!
    const toks = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
    return `${esc(String(m))} ${u.calls} 次调用 / ${groupDigits(toks)} tokens`
  })
  let line = parts.join(' · ')
  const elapsed = report.usageSummary?.elapsed_seconds
  if (elapsed !== undefined) line = `总耗时 ${elapsed} 秒 · ${line}`
  return line
}

function gateFailBody(g: GateResult | null): string {
  const rows: string[] = []
  if (g) {
    const wordOk = g.wordCount >= g.minWords
    const dupOk = g.duplicationRate < g.dupThreshold
    rows.push(`<li>字数：<b>${g.wordCount}</b>（须 ≥ ${g.minWords}）${wordOk ? '✔' : '✘'}</li>`)
    rows.push(`<li>查重率：<b>${pct1(g.duplicationRate)}</b>（须 &lt; ${(g.dupThreshold * 100).toFixed(0)}%）${dupOk ? '✔' : '✘'}</li>`)
    rows.push(...g.formatIssues.map((i) => `<li>格式：${esc(i)}</li>`))
  }
  const warnHtml =
    g && g.warnings.length
      ? `<h3>另需注意（警告项）</h3><ul>${g.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : ''
  return `
    <div class="scorecard">
      <div class="total">
        <div class="num" style="color:var(--red)">—</div>
        <div class="grade">未进入评卷</div>
      </div>
      <div class="radar"></div>
      <div><span class="stamp red">打回</span></div>
    </div>

    <section class="fraud-mark">
      <div class="kicker">GATE · 硬性门检</div>
      <h2>未通过硬性门检</h2>
      <ul>${rows.join('')}</ul>
      ${warnHtml}
      <p class="muted note">按评卷章程：查重率与字数达标、要素齐全方可送审。
      修改后欢迎重新投稿。</p>
    </section>`
}

function reportBody(report: ReviewReport, g: GateResult | null): string {
  const total = report.finalScore
  const totalMax = report.panels.reduce((acc, v) => acc + v.maxScore, 0)
  let stampCls = ''
  let stampText = ''
  let verdict = ''
  let verdictColor = ''
  if (report.vetoed) {
    stampCls = 'red'
    stampText = '否决'
    verdict = '一票否决（作假成立）'
    verdictColor = 'var(--red)'
  } else if (report.passed) {
    stampCls = ''
    stampText = '通过'
    verdict = '评卷通过'
    verdictColor = 'var(--ink)'
  } else {
    stampCls = 'red'
    stampText = '未过'
    verdict = '未通过'
    verdictColor = 'var(--red)'
  }

  // ---------- 修改路线 ----------
  const roadmapRows = report.revisionRoadmap.map(
    (r) =>
      `<tr><td class='num'>${esc(String(r.priority ?? ''))}</td>` +
      `<td>${sevChip(String(r.severity ?? ''))}</td>` +
      `<td>${esc(String(r.issue ?? ''))}</td>` +
      `<td>${esc(String(r.action ?? ''))}</td>` +
      `<td>${esc(String(r.location ?? ''))}</td></tr>`,
  )
  const roadmapBody = roadmapRows.join('') || "<tr><td colspan='5' class='muted'>无</td></tr>"

  // ---------- 作假专区 ----------
  let fraudHtml = ''
  if (report.fraudFindings.length) {
    const frows = report.fraudFindings
      .map(
        (f) =>
          `<tr><td>${esc(f.fraudType)}</td><td>${esc(f.location)}</td>` +
          `<td>${esc(f.evidence)}</td><td>${sevChip(f.severity)}</td></tr>`,
      )
      .join('')
    let vetoBlock = ''
    if (report.vetoed) {
      const reasons = report.vetoReasons.map((r) => `<li>${esc(r)}</li>`).join('')
      vetoBlock =
        `<div class='veto'><span class='stamp red'>否决</span>` +
        `<div><b>总仲裁裁定：作假成立，一票否决。</b><ul>${reasons}</ul></div></div>`
    }
    fraudHtml = `
    <section class="fraud-mark">
      <div class="kicker">FRAUD · 作假审查</div>
      <h2>作假审查专区</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>类型</th><th>定位</th><th>证据</th><th>严重度</th></tr></thead>
        <tbody>${frows}</tbody></table></div>
      ${vetoBlock}
    </section>`
  }

  // ---------- 门检提示 ----------
  let gateWarnHtml = ''
  if (g && g.warnings.length) {
    const items = g.warnings.map((w) => `<li>${esc(w)}</li>`).join('')
    gateWarnHtml = `
    <section class="gate-warn">
      <div class="kicker">GATE NOTES · 门检提示</div>
      <h2>警告项（不拦截）</h2>
      <ul>${items}</ul>
    </section>`
  }

  // ---------- 评审团 ----------
  let panelsHtml = ''
  for (const v of report.panels) {
    let judgeHtml = ''
    for (const s of v.sheets) {
      let dedRows = ''
      for (const d of s.deductions) {
        dedRows +=
          `<tr><td>${sevChip(d.severity)}</td>` +
          `<td>${esc(d.location)}</td>` +
          `<td>${esc(d.description)}</td>` +
          `<td>${esc(d.suggestion)}</td>` +
          `<td class='num'>${pyFloat(d.deduction)}</td></tr>`
      }
      const dedBody = dedRows || "<tr><td colspan='5' class='muted'>无扣分点</td></tr>"
      const confLow = s.confidence < 0.6
      judgeHtml += `
            <details>
              <summary>${esc(s.judgeName)}
                <span class="jsum"><b>${pyFloat(s.score)}</b>／${s.maxScore}
                · 置信度 <span class="${confLow ? 'conf-low' : ''}">${s.confidence.toFixed(2)}</span>${confLow ? ' · 建议人工复核' : ''}
                · ${esc(s.model)}</span></summary>
              <div class="table-wrap"><table>
                <thead><tr><th>等第</th><th>定位</th><th>问题描述</th><th>修改建议</th><th>扣分</th></tr></thead>
                <tbody>${dedBody}</tbody></table></div>
            </details>`
    }
    const arbItems = v.arbitration
      .map(
        (a) =>
          `<li><code>${esc(a.action)}</code> ${esc(a.actor)}：${esc(a.detail)}</li>`,
      )
      .join('')
    panelsHtml += `
    <section>
      <div class="kicker">PANEL · 评审团</div>
      <h2>${esc(v.panelName)}：<span class="score">${pyFloat(v.finalScore)}</span>
        <span class="of">／ ${v.maxScore}</span></h2>
      ${judgeHtml}
      <h3>团内仲裁记录</h3>
      <ul class="arb">${arbItems || '<li class="muted">无</li>'}</ul>
    </section>`
  }

  // ---------- 回放 ----------
  const replayItems = report.replay
    .map(
      (a) =>
        `<li><code>${esc(a.level)}</code> ${esc(a.actor)}：${esc(a.action)} — ${esc(a.detail)}</li>`,
    )
    .join('')
  const usage = usageLine(report)

  return `
    <div class="scorecard">
      <div class="total">
        <div class="num" style="color:${verdictColor}">${pyFloat(total)}</div>
        <div class="grade">${gradeOf(total, totalMax)} · ${verdict}</div>
      </div>
      <div class="radar"><canvas id="radar" aria-label="四团得分雷达图"></canvas></div>
      <div><span class="stamp ${stampCls}">${stampText}</span></div>
    </div>

    <section>
      <div class="kicker">REVISIONS · 修改路线</div>
      <h2>修改优先级路线图</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>等第</th><th>问题</th><th>修改动作</th><th>定位</th></tr></thead>
        <tbody>${roadmapBody}</tbody></table></div>
    </section>

    ${gateWarnHtml}
    ${fraudHtml}
    ${panelsHtml}

    <section>
      <div class="kicker">REPLAY · 评卷回放</div>
      <h2>评卷过程回放</h2>
      <details><summary>展开 ${report.replay.length} 条仲裁与流程记录</summary>
        <ul class="replay">${replayItems || '<li class="muted">无</li>'}</ul>
      </details>
    </section>`
}

/** 渲染单文件 HTML 报告。 */
export function renderHtml(report: ReviewReport): string {
  const g = report.gate
  const gatePass = Boolean(g && g.passed)
  const body = gatePass ? reportBody(report, g) : gateFailBody(g)

  const title = esc(report.paperTitle || '论文评卷报告')
  const usage = usageLine(report)
  const usageHtml = usage ? `<div class="usage">${usage}</div>` : ''
  const issue = '第 一 期 · 毕业论文评卷特辑'
  const dateline = `${issue} · ${esc(report.mode.toUpperCase())} 本`
  const radarData = (gatePass ? report.panels : []).map((v) => ({
    name: v.panelName,
    score: v.finalScore,
    max: v.maxScore,
  }))
  const radarJson = JSON.stringify(radarData).replace(/<\//g, '<\\/')

  const radarScript = gatePass
    ? `<script id="radar-data" type="application/json">${radarJson}</script><script>${JS}</script>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>研证 · 评卷纪要 · ${title}</title>
<style>${CSS}</style></head><body>
<main>
  <div class="dateline">${dateline}</div>
  <div class="masthead"><h1>研<span class="dot">·</span>证</h1></div>
  <div class="eng">Yanzheng — The Thesis Review</div>
  <div class="double"></div>
  <p class="headline">${title}</p>
  <p class="byline"><i>评卷</i> · 由研证评卷团（四团十三员）独立执笔 · 分差仲裁 · 作假否决</p>

  ${body}

  <div class="colophon">
    研证 · 评卷纪要 · report_id ${esc(report.reportId)} · mode ${esc(report.mode)}
    ${usageHtml}
  </div>
</main>
${radarScript}
</body></html>`
}
