import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const WEIGH_DIR = join(homedir(), ".pi", "weigh");
const HISTORY_FILE = join(WEIGH_DIR, "history.jsonl");

function ensureWeighDir() {
  if (!existsSync(WEIGH_DIR)) mkdirSync(WEIGH_DIR, { recursive: true });
}

interface WeighSnapshot {
  ts: string;
  totalTokens: number;
  toolCount: number;
  activeToolCount: number;
  promptPercent: number;
  contextWindow: number;
  topTools: Array<{ name: string; tokens: number }>;
}

function appendSnapshot(snap: WeighSnapshot) {
  ensureWeighDir();
  appendFileSync(HISTORY_FILE, JSON.stringify(snap) + "\n");
}

function loadHistory(limit = 50): WeighSnapshot[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const lines = readFileSync(HISTORY_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export default function piWeigh(pi: ExtensionAPI) {
  // ── Tokenizer: cl100k_base approximation ──────────────────────────
  // GPT/Claude tokenizers average ~4 chars per token for English text.
  // For system prompts (structured, keyword-heavy), 3.5 is more accurate.
  // We also count JSON schema tokens from tool parameters.
  const CHARS_PER_TOKEN = 3.5;

  function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  // ── Extract tool descriptions from system prompt ──────────────────
  function parseToolBurden(systemPrompt: string, allTools: Array<{ name: string; description?: string; parameters?: unknown }>) {
    const tools: Array<{ name: string; tokens: number; source: string; description: string }> = [];

    for (const tool of allTools) {
      // Build what the provider actually sends: name + description + parameter schema
      let toolText = `${tool.name}\n`;
      if (tool.description) toolText += tool.description + "\n";
      if (tool.parameters) toolText += JSON.stringify(tool.parameters) + "\n";
      
      const tokens = estimateTokens(toolText);
      
      // Determine source
      let source = "built-in";
      if (tool.name.startsWith("dj_") || tool.name.startsWith("ffmpeg_") || tool.name === "remotion_render") {
        source = "npm-extension";
      } else if (["read", "bash", "edit", "write"].includes(tool.name)) {
        source = "built-in";
      } else {
        // Check if it's one of our local extensions
        const localTools = [
          "sentinel_policy", "sentinel_audit", "sentinel_scan",
          "kg_add", "kg_query", "kg_export",
          "rag_index", "rag_query", "rag_status",
          "comply_classify", "comply_audit", "comply_log",
          "arena_run", "arena_history", "arena_compare",
          "eval_judge", "eval_handoff", "grounded_discover",
          "http_request", "intel_scan", "intel_compare", "intel_trends",
          "json_query", "leads_add", "leads_search", "leads_followup", "leads_pipeline",
          "validate_project", "voice_capture", "estimate_tokens", "strip_metadata",
          "unicode_scan", "handy_transcribe",
          "token_burden", "token_burden_tools"
        ];
        if (localTools.includes(tool.name)) {
          source = "local-extension";
        } else {
          source = "npm-extension";
        }
      }

      tools.push({
        name: tool.name,
        tokens,
        source,
        description: (tool.description || "").slice(0, 80)
      });
    }

    return tools.sort((a, b) => b.tokens - a.tokens);
  }

  // ── Parse system prompt sections ──────────────────────────────────
  function parseSystemPromptSections(prompt: string) {
    const sections: Array<{ name: string; tokens: number; percent: number }> = [];
    const totalTokens = estimateTokens(prompt);

    // Split by major markers
    const skillBlock = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    const projectContext = prompt.match(/# Project Context[\s\S]*?(?=<available_skills>|$)/);
    const toolDocs = prompt.match(/Available tools:[\s\S]*?(?=# Project Context|<available_skills>|$)/);
    
    // Core instructions (everything before Available tools)
    const coreMatch = prompt.match(/^[\s\S]*?(?=Available tools:|$)/);
    if (coreMatch) {
      const tokens = estimateTokens(coreMatch[0]);
      sections.push({ name: "Core instructions", tokens, percent: (tokens / totalTokens) * 100 });
    }

    if (toolDocs) {
      const tokens = estimateTokens(toolDocs[0]);
      sections.push({ name: "Tool descriptions", tokens, percent: (tokens / totalTokens) * 100 });
    }

    if (projectContext) {
      const tokens = estimateTokens(projectContext[0]);
      sections.push({ name: "Project context (AGENTS.md)", tokens, percent: (tokens / totalTokens) * 100 });
    }

    if (skillBlock) {
      const tokens = estimateTokens(skillBlock[0]);
      sections.push({ name: "Skill catalog", tokens, percent: (tokens / totalTokens) * 100 });
    }

    // Account for unmatched content
    const accounted = sections.reduce((sum, s) => sum + s.tokens, 0);
    if (totalTokens - accounted > 50) {
      sections.push({ name: "Other/overhead", tokens: totalTokens - accounted, percent: ((totalTokens - accounted) / totalTokens) * 100 });
    }

    return { sections: sections.sort((a, b) => b.tokens - a.tokens), totalTokens };
  }

  // ── Slash command: /token-burden ──────────────────────────────────
  pi.registerCommand("weigh", {
    description: "Show token budget breakdown of the system prompt and all tools",
    handler: async (args, ctx) => {
      const systemPrompt = ctx.getSystemPrompt();
      const allTools = ctx.getAllTools();
      const activeTools = ctx.getActiveTools();
      const contextUsage = ctx.getContextUsage();

      // 1. System prompt sections
      const { sections, totalTokens } = parseSystemPromptSections(systemPrompt);

      // 2. Per-tool breakdown
      const toolBurden = parseToolBurden(systemPrompt, allTools);
      const totalToolTokens = toolBurden.reduce((sum, t) => sum + t.tokens, 0);

      // 3. Source breakdown
      const bySource = new Map<string, { count: number; tokens: number }>();
      for (const t of toolBurden) {
        const entry = bySource.get(t.source) || { count: 0, tokens: 0 };
        entry.count++;
        entry.tokens += t.tokens;
        bySource.set(t.source, entry);
      }

      // 4. Write HTML report
      const htmlPath = join(tmpdir(), "pi-weigh.html");
      const contextInfo = contextUsage && contextUsage.tokens !== null
        ? `Used: ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} (${contextUsage.percent?.toFixed(1)}%)<br>System prompt: ~${totalTokens.toLocaleString()} tokens (${((totalTokens / contextUsage.contextWindow) * 100).toFixed(1)}% of window)`
        : `System prompt: ~${totalTokens.toLocaleString()} tokens<br><span style="color:#8b949e">Context usage unknown — available after first LLM response</span>`;

      const contextWindow = contextUsage?.contextWindow || 200000;
      const promptPercent = (totalTokens / contextWindow) * 100;
      const healthColor = promptPercent > 15 ? "#f85149" : promptPercent > 10 ? "#d29922" : "#3fb950";
      const healthIcon = promptPercent > 15 ? "🔴" : promptPercent > 10 ? "🟡" : "🟢";

      const toolRows = toolBurden.slice(0, 20).map((t, i) => {
        const active = activeTools.includes(t.name);
        return `<tr><td>${i + 1}</td><td>${active ? "✓" : '<span style="color:#f85149">✗</span>'}</td><td class="mono">${t.name}</td><td style="text-align:right">${t.tokens.toLocaleString()}</td><td>${t.source}</td></tr>`;
      }).join("\n");

      const sectionRows = sections.map(s => {
        const barWidth = Math.round(s.percent * 2);
        return `<tr><td>${s.name}</td><td style="text-align:right">${s.tokens.toLocaleString()}</td><td style="text-align:right">${s.percent.toFixed(1)}%</td><td><div style="background:${healthColor};height:12px;width:${barWidth}px;border-radius:3px;"></div></td></tr>`;
      }).join("\n");

      const sourceRows = [...bySource.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([source, data]) =>
        `<tr><td>${source}</td><td style="text-align:right">${data.count}</td><td style="text-align:right">${data.tokens.toLocaleString()}</td></tr>`
      ).join("\n");

      const inactiveHeavy = toolBurden.filter(t => !activeTools.includes(t.name) && t.tokens > 100);
      
      // Deactivation suggestions — tools that cost >200 tokens and could be deactivated
      const deactivateCandidates = toolBurden
        .filter(t => activeTools.includes(t.name) && t.tokens > 200 && !["read", "bash", "edit", "write"].includes(t.name))
        .slice(0, 5);
      
      const deactivateRows = deactivateCandidates.map(t => 
        `<tr><td class="mono">${t.name}</td><td style="text-align:right">${t.tokens.toLocaleString()}</td><td>${t.source}</td><td style="color:var(--dim)">${t.description.slice(0, 50)}...</td></tr>`
      ).join("\n");
      
      const deactivateSavings = deactivateCandidates.reduce((s, t) => s + t.tokens, 0);

      // ── GPT-5.4 Tool Search Efficiency Analysis ────────────────
      // GPT-5.4 introduced "tool search" — lightweight tool index instead of full definitions.
      // This reduced token usage by 47% on MCP Atlas benchmark (250 tasks, 36 MCP servers).
      // We calculate what a tool-search approach would save for our tool set.
      const toolSearchIndexTokens = toolBurden.reduce((sum, t) => {
        // A lightweight index entry: name + 10-word description ≈ 15 tokens per tool
        return sum + 15;
      }, 0);
      const toolSearchSavings = totalToolTokens - toolSearchIndexTokens;
      const toolSearchPct = totalToolTokens > 0 ? ((toolSearchSavings / totalToolTokens) * 100).toFixed(0) : "0";

      // Parse skills from system prompt
      const skillMatches = systemPrompt.matchAll(/<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>/gs);
      const skillRows: string[] = [];
      let skillTotalTokens = 0;
      for (const m of skillMatches) {
        const name = m[1].trim();
        const desc = m[2].trim();
        const tokens = estimateTokens(`<skill><name>${name}</name><description>${desc}</description><location>...</location></skill>`);
        skillTotalTokens += tokens;
        skillRows.push(`<tr><td class="mono">${name}</td><td style="text-align:right">${tokens}</td><td style="color:var(--dim)">${desc.slice(0, 60)}...</td></tr>`);
      }
      skillRows.sort((a, b) => {
        const tokA = parseInt(a.match(/right">(\d+)/)?.[1] || "0");
        const tokB = parseInt(b.match(/right">(\d+)/)?.[1] || "0");
        return tokB - tokA;
      });

      // Save snapshot for history tracking
      appendSnapshot({
        ts: new Date().toISOString(),
        totalTokens,
        toolCount: allTools.length,
        activeToolCount: activeTools.length,
        promptPercent: +promptPercent.toFixed(1),
        contextWindow,
        topTools: toolBurden.slice(0, 5).map(t => ({ name: t.name, tokens: t.tokens })),
      });
      
      // Load history for trend
      const history = loadHistory(20);
      const historySection = history.length > 1
        ? `<h2>📈 Token Burden History</h2>
           <table><tr><th>Date</th><th>Tokens</th><th>Tools</th><th>% Window</th><th>Trend</th></tr>
           ${history.slice(-10).map((h, i, arr) => {
             const prev = i > 0 ? arr[i - 1].totalTokens : h.totalTokens;
             const delta = h.totalTokens - prev;
             const trend = delta > 100 ? '<span style="color:#f85149">↑ +' + delta + '</span>' : delta < -100 ? '<span style="color:#3fb950">↓ ' + delta + '</span>' : '<span style="color:var(--dim)">→</span>';
             return `<tr><td>${h.ts.slice(0, 16)}</td><td style="text-align:right">${h.totalTokens.toLocaleString()}</td><td style="text-align:right">${h.toolCount}</td><td style="text-align:right">${h.promptPercent}%</td><td>${trend}</td></tr>`;
           }).join("\n")}
           </table>`
        : "";

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Token Burden Report</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem;max-width:1100px;margin:0 auto}
h1{font-size:1.6rem;margin-bottom:.3rem}
h2{font-size:1.1rem;color:#58a6ff;margin:1.5rem 0 .8rem;border-bottom:1px solid var(--border);padding-bottom:.4rem}
.sub{color:var(--dim);font-size:.85rem;margin-bottom:1.5rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(3,1fr);margin-bottom:1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;text-align:center}
.stat{font-size:2rem;font-weight:700}
.stat-label{color:var(--dim);font-size:.7rem}
table{width:100%;border-collapse:collapse;font-size:.82rem;margin-bottom:1rem}
th,td{padding:.4rem .6rem;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--dim);font-weight:600}
.mono{font-family:'JetBrains Mono','Cascadia Code',monospace}
.reco{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-top:1rem}
</style></head><body>
<h1>📊 Token Burden Report</h1>
<p class="sub">Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")}</p>
<div class="grid">
  <div class="card"><div class="stat" style="color:${healthColor}">${totalTokens.toLocaleString()}</div><div class="stat-label">System Prompt Tokens</div></div>
  <div class="card"><div class="stat" style="color:#58a6ff">${allTools.length}</div><div class="stat-label">Tools (${activeTools.length} active)</div></div>
  <div class="card"><div class="stat" style="color:${healthColor}">${promptPercent.toFixed(1)}%</div><div class="stat-label">${healthIcon} Of Context Window</div></div>
</div>
<p style="color:var(--dim);font-size:.85rem;margin-bottom:1rem">🔄 ${contextInfo}</p>
<h2>📋 System Prompt Sections</h2>
<table><tr><th>Section</th><th>Tokens</th><th>%</th><th>Weight</th></tr>${sectionRows}
<tr style="font-weight:700"><td>TOTAL</td><td style="text-align:right">${totalTokens.toLocaleString()}</td><td></td><td></td></tr></table>
<h2>🔧 Tools by Source</h2>
<table><tr><th>Source</th><th>Count</th><th>Tokens</th></tr>${sourceRows}
<tr style="font-weight:700"><td>TOTAL</td><td style="text-align:right">${allTools.length}</td><td style="text-align:right">${totalToolTokens.toLocaleString()}</td></tr></table>
<h2>🏋️ Top 20 Heaviest Tools</h2>
<table><tr><th>#</th><th>Active</th><th>Tool</th><th>Tokens</th><th>Source</th></tr>${toolRows}</table>
${skillRows.length ? `<h2>📚 Skill Catalog Cost (${skillRows.length} skills, ~${skillTotalTokens.toLocaleString()} tokens)</h2>
<table><tr><th>Skill</th><th>Tokens</th><th>Description</th></tr>${skillRows.slice(0, 15).join("\n")}
${skillRows.length > 15 ? `<tr><td colspan="3" style="color:var(--dim)">... ${skillRows.length - 15} more skills</td></tr>` : ""}
</table>` : ""}
${deactivateCandidates.length ? `<h2>💤 Deactivation Candidates (save ~${deactivateSavings.toLocaleString()} tokens)</h2>
<p style="color:var(--dim);font-size:.8rem;margin-bottom:.5rem">These active tools cost >200 tokens each and could be deactivated when not needed</p>
<table><tr><th>Tool</th><th>Tokens</th><th>Source</th><th>Description</th></tr>${deactivateRows}</table>` : ""}
<h2>🔍 Tool Search Efficiency (GPT-5.4 Pattern)</h2>
<p style="color:var(--dim);font-size:.8rem;margin-bottom:.5rem">GPT-5.4 replaced full tool schemas with a lightweight search index — 47% savings on MCP Atlas (250 tasks, 36 servers)</p>
<div class="grid" style="grid-template-columns:1fr 1fr 1fr">
  <div class="card"><div class="stat" style="color:#f85149">${totalToolTokens.toLocaleString()}</div><div class="stat-label">Current: Full Schemas</div></div>
  <div class="card"><div class="stat" style="color:#3fb950">${toolSearchIndexTokens.toLocaleString()}</div><div class="stat-label">With Tool Search Index</div></div>
  <div class="card"><div class="stat" style="color:#58a6ff">${toolSearchPct}%</div><div class="stat-label">Potential Savings</div></div>
</div>
<p style="color:var(--dim);font-size:.8rem">If pi adopted GPT-5.4's tool-search pattern, tools would cost ~${toolSearchIndexTokens.toLocaleString()} tokens (index only) instead of ${totalToolTokens.toLocaleString()} (full schemas). Full definitions loaded on-demand when the model calls tool_search.</p>
${historySection}
<div class="reco"><h2 style="border:0;margin:0 0 .5rem">💡 Recommendations</h2>
<p>${healthIcon} System prompt uses <strong>${promptPercent.toFixed(1)}%</strong> of context window${promptPercent > 15 ? " — <span style='color:#f85149'>consider pruning skills or tool descriptions</span>" : promptPercent > 10 ? " — monitor but OK" : " — healthy"}</p>
${inactiveHeavy.length ? `<p style="margin-top:.5rem">⚠️ ${inactiveHeavy.length} inactive tools still registered (${inactiveHeavy.reduce((s, t) => s + t.tokens, 0).toLocaleString()} tokens wasted)</p>` : ""}
<p style="margin-top:.5rem;color:var(--dim);font-size:.8rem">System prompt: ${systemPrompt.length.toLocaleString()} chars → ~${totalTokens.toLocaleString()} tokens | ${allTools.length} tools | ${activeTools.length} active</p>
</div>
<p style="text-align:center;color:var(--dim);font-size:.75rem;margin-top:1.5rem">pi-weigh · built locally · ${new Date().toISOString().slice(0, 10)}</p>
</body></html>`;

      writeFileSync(htmlPath, html);

      // Also output summary to terminal
      const summary = [
        `📊 Token Burden: ~${totalTokens.toLocaleString()} tokens (${promptPercent.toFixed(1)}% of ${contextWindow.toLocaleString()} window)`,
        `🔧 ${allTools.length} tools (${activeTools.length} active), ${totalToolTokens.toLocaleString()} tool tokens`,
        `${healthIcon} Health: ${promptPercent > 15 ? "HIGH — prune recommended" : promptPercent > 10 ? "MODERATE — monitor" : "HEALTHY"}`,
        `📄 Full report: ${htmlPath}`,
      ].join("\n");

      ctx.ui.notify(summary, "info");

      // Auto-open in browser
      try {
        const { execSync } = await import("node:child_process");
        execSync(`start "" "${htmlPath}"`, { stdio: "ignore" });
      } catch {}
    }
  });

  // ── Tool: token_burden ────────────────────────────────────────────
  // Machine-readable version for agents to query
  pi.registerTool({
    name: "weigh",
    description: "Get token burden breakdown of the current system prompt and tools. Returns structured data about what's consuming context budget.",
    parameters: { type: "object" as const, properties: {} },
    execute: async (_params, ctx) => {
      const systemPrompt = ctx.getSystemPrompt();
      const allTools = ctx.getAllTools();
      const activeTools = ctx.getActiveTools();
      const contextUsage = ctx.getContextUsage();
      const { sections, totalTokens } = parseSystemPromptSections(systemPrompt);
      const toolBurden = parseToolBurden(systemPrompt, allTools);

      return {
        systemPromptChars: systemPrompt.length,
        systemPromptTokens: totalTokens,
        contextWindow: contextUsage?.contextWindow || null,
        contextUsedTokens: contextUsage?.tokens || null,
        contextUsedPercent: contextUsage?.percent || null,
        promptPercentOfWindow: contextUsage?.contextWindow
          ? +((totalTokens / contextUsage.contextWindow) * 100).toFixed(1)
          : null,
        sections,
        toolCount: allTools.length,
        activeToolCount: activeTools.length,
        toolTokensTotal: toolBurden.reduce((s, t) => s + t.tokens, 0),
        top10Tools: toolBurden.slice(0, 10).map(t => ({
          name: t.name,
          tokens: t.tokens,
          active: activeTools.includes(t.name),
          source: t.source
        }))
      };
    }
  });
}
