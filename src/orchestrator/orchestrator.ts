/**
 * @fileoverview OpenMultiAgent — the top-level multi-agent orchestration class.
 *
 * {@link OpenMultiAgent} is the primary public API of the open-multi-agent framework.
 * It ties together every subsystem:
 *
 *  - {@link Team}       — Agent roster, shared memory, inter-agent messaging
 *  - {@link TaskQueue}  — Dependency-aware work queue
 *  - {@link Scheduler}  — Task-to-agent assignment strategies
 *  - {@link AgentPool}  — Concurrency-controlled execution pool
 *  - {@link Agent}      — Conversation + tool-execution loop
 *
 * ## Quick start
 *
 * ```ts
 * const orchestrator = new OpenMultiAgent({ defaultModel: 'claude-opus-4-6' })
 *
 * const team = orchestrator.createTeam('research', {
 *   name: 'research',
 *   agents: [
 *     { name: 'researcher', model: 'claude-opus-4-6', systemPrompt: 'You are a researcher.' },
 *     { name: 'writer',     model: 'claude-opus-4-6', systemPrompt: 'You are a technical writer.' },
 *   ],
 *   sharedMemory: true,
 * })
 *
 * const result = await orchestrator.runTeam(team, 'Produce a report on TypeScript 5.5.')
 * console.log(result.agentResults.get('coordinator')?.output)
 * ```
 *
 * ## Key design decisions
 *
 * - **Coordinator pattern** — `runTeam()` spins up a temporary "coordinator" agent
 *   that breaks the high-level goal into tasks, assigns them, and synthesises the
 *   final answer. This is the framework's killer feature.
 * - **Parallel-by-default** — Independent tasks (no shared dependency) run in
 *   parallel up to `maxConcurrency`.
 * - **Graceful failure** — A failed task marks itself `'failed'` and its direct
 *   dependents remain `'blocked'` indefinitely; all non-dependent tasks continue.
 * - **Progress callbacks** — Callers can pass `onProgress` in the config to receive
 *   structured {@link OrchestratorEvent}s without polling.
 */

import type {
  AgentConfig,
  AgentRunResult,
  CoordinatorConfig,
  OrchestratorConfig,
  OrchestratorEvent,
  Task,
  TaskStatus,
  TeamConfig,
  TeamRunResult,
  TokenUsage,
} from '../types.js'
import type { RunOptions } from '../agent/runner.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Agent } from '../agent/agent.js'
import { AgentPool } from '../agent/pool.js'
import { emitTrace, generateRunId } from '../utils/trace.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { Team } from '../team/team.js'
import { TaskQueue } from '../task/queue.js'
import { createTask } from '../task/task.js'
import { Scheduler } from './scheduler.js'
import { TokenBudgetExceededError } from '../errors.js'
import { extractKeywords, keywordScore } from '../utils/keywords.js'

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0 }
const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MODEL = 'claude-opus-4-6'

// ---------------------------------------------------------------------------
// Short-circuit helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Regex patterns that indicate a goal requires multi-agent coordination.
 *
 * Each pattern targets a distinct complexity signal:
 * - Sequencing:     "first … then", "step 1 / step 2", numbered lists
 * - Coordination:   "collaborate", "coordinate", "review each other"
 * - Parallel work:  "in parallel", "at the same time", "concurrently"
 * - Multi-phase:    "phase", "stage", multiple distinct action verbs joined by connectives
 */
const COMPLEXITY_PATTERNS: RegExp[] = [
  // Explicit sequencing
  /\bfirst\b.{3,60}\bthen\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\bstage\s*\d/i,
  /^\s*\d+[\.\)]/m,                       // numbered list items ("1. …", "2) …")

  // Coordination language — must be an imperative directive aimed at the agents
  // ("collaborate with X", "coordinate the team", "agents should coordinate"),
  // not a descriptive use ("how does X coordinate with Y" / "what does collaboration mean").
  // Match either an explicit preposition or a noun-phrase that names a group.
  /\bcollaborat(?:e|ing)\b\s+(?:with|on|to)\b/i,
  /\bcoordinat(?:e|ing)\b\s+(?:with|on|across|between|the\s+(?:team|agents?|workers?|effort|work))\b/i,
  /\breview\s+each\s+other/i,
  /\bwork\s+together\b/i,

  // Parallel execution
  /\bin\s+parallel\b/i,
  /\bconcurrently\b/i,
  /\bat\s+the\s+same\s+time\b/i,

  // Multiple deliverables joined by connectives
  // Matches patterns like "build X, then deploy Y and test Z"
  /\b(?:build|create|implement|design|write|develop)\b.{5,80}\b(?:and|then)\b.{5,80}\b(?:build|create|implement|design|write|develop|test|review|deploy)\b/i,
]


/**
 * Maximum goal length (in characters) below which a goal *may* be simple.
 *
 * Goals longer than this threshold almost always contain enough detail to
 * warrant multi-agent decomposition. The value is generous — short-circuit
 * is meant for genuinely simple, single-action goals.
 */
const SIMPLE_GOAL_MAX_LENGTH = 200

/**
 * Determine whether a goal is simple enough to skip coordinator decomposition.
 *
 * A goal is considered "simple" when ALL of the following hold:
 *   1. Its length is ≤ {@link SIMPLE_GOAL_MAX_LENGTH}.
 *   2. It does not match any {@link COMPLEXITY_PATTERNS}.
 *
 * The complexity patterns are deliberately conservative — they only fire on
 * imperative coordination directives (e.g. "collaborate with the team",
 * "coordinate the workers"), so descriptive uses ("how do pods coordinate
 * state", "explain microservice collaboration") remain classified as simple.
 *
 * Exported for unit testing.
 */
export function isSimpleGoal(goal: string): boolean {
  if (goal.length > SIMPLE_GOAL_MAX_LENGTH) return false
  return !COMPLEXITY_PATTERNS.some((re) => re.test(goal))
}

/**
 * Select the best-matching agent for a goal using keyword affinity scoring.
 *
 * The scoring logic mirrors {@link Scheduler}'s `capability-match` strategy
 * exactly, including its asymmetric use of the agent's `model` field:
 *
 *  - `agentKeywords` is computed from `name + systemPrompt + model` so that
 *    a goal which mentions a model name (e.g. "haiku") can boost an agent
 *    bound to that model.
 *  - `agentText` (used for the reverse direction) is computed from
 *    `name + systemPrompt` only — model names should not bias the
 *    text-vs-goal-keywords match.
 *
 * The two-direction sum (`scoreA + scoreB`) ensures both "agent describes
 * goal" and "goal mentions agent capability" contribute to the final score.
 *
 * Exported for unit testing.
 */
export function selectBestAgent(goal: string, agents: AgentConfig[]): AgentConfig {
  if (agents.length <= 1) return agents[0]!

  const goalKeywords = extractKeywords(goal)

  let bestAgent = agents[0]!
  let bestScore = -1

  for (const agent of agents) {
    const agentText = `${agent.name} ${agent.systemPrompt ?? ''}`
    // Mirror Scheduler.capability-match: include `model` here only.
    const agentKeywords = extractKeywords(`${agent.name} ${agent.systemPrompt ?? ''} ${agent.model}`)

    const scoreA = keywordScore(agentText, goalKeywords)
    const scoreB = keywordScore(goal, agentKeywords)
    const score = scoreA + scoreB

    if (score > bestScore) {
      bestScore = score
      bestAgent = agent
    }
  }

  return bestAgent
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

function resolveTokenBudget(primary?: number, fallback?: number): number | undefined {
  if (primary === undefined) return fallback
  if (fallback === undefined) return primary
  return Math.min(primary, fallback)
}

interface DashboardTaskMetrics {
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly tokenUsage: TokenUsage
  readonly toolCalls: AgentRunResult['toolCalls']
}

interface DashboardTaskNode {
  readonly id: string
  readonly title: string
  readonly assignee?: string
  readonly status: TaskStatus
  readonly dependsOn: readonly string[]
  readonly metrics?: DashboardTaskMetrics
}

function buildRunTeamDashboardHtml(_goal: string, _tasks: DashboardTaskNode[]): string {
  const dataJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    goal: _goal,
    tasks: _tasks,
  })

  return `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
    <meta charset="utf-8" />
    <meta content="width=device-width, initial-scale=1.0" name="viewport" />
    <title>Open Multi Agent</title>
    <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
    <link
        href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&amp;family=Inter:wght@400;500;600&amp;display=swap"
        rel="stylesheet" />
    <link
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap"
        rel="stylesheet" />
    <link
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap"
        rel="stylesheet" />
    <script id="tailwind-config">
        tailwind.config = {
            darkMode: "class",
            theme: {
                extend: {
                    "colors": {
                        "inverse-surface": "#faf8ff",
                        "secondary-dim": "#ecb200",
                        "on-primary": "#005762",
                        "on-tertiary-fixed-variant": "#006827",
                        "primary-fixed-dim": "#00d4ec",
                        "tertiary-container": "#5cfd80",
                        "secondary": "#fdc003",
                        "primary-dim": "#00d4ec",
                        "surface-container": "#0f1930",
                        "on-secondary": "#553e00",
                        "surface": "#060e20",
                        "on-surface": "#dee5ff",
                        "surface-container-highest": "#192540",
                        "on-secondary-fixed-variant": "#674c00",
                        "on-tertiary-container": "#005d22",
                        "secondary-fixed-dim": "#f7ba00",
                        "surface-variant": "#192540",
                        "surface-container-low": "#091328",
                        "secondary-container": "#785900",
                        "tertiary-fixed-dim": "#4bee74",
                        "on-primary-fixed-variant": "#005762",
                        "primary-container": "#00e3fd",
                        "surface-dim": "#060e20",
                        "error-container": "#9f0519",
                        "on-error-container": "#ffa8a3",
                        "primary-fixed": "#00e3fd",
                        "tertiary-dim": "#4bee74",
                        "surface-container-high": "#141f38",
                        "background": "#060e20",
                        "surface-bright": "#1f2b49",
                        "error-dim": "#d7383b",
                        "on-primary-container": "#004d57",
                        "outline": "#6d758c",
                        "error": "#ff716c",
                        "on-secondary-container": "#fff6ec",
                        "on-primary-fixed": "#003840",
                        "inverse-on-surface": "#4d556b",
                        "secondary-fixed": "#ffca4d",
                        "tertiary-fixed": "#5cfd80",
                        "on-tertiary-fixed": "#004819",
                        "surface-tint": "#81ecff",
                        "tertiary": "#b8ffbb",
                        "outline-variant": "#40485d",
                        "on-error": "#490006",
                        "on-surface-variant": "#a3aac4",
                        "surface-container-lowest": "#000000",
                        "on-tertiary": "#006727",
                        "primary": "#81ecff",
                        "on-secondary-fixed": "#443100",
                        "inverse-primary": "#006976",
                        "on-background": "#dee5ff"
                    },
                    "borderRadius": {
                        "DEFAULT": "0px",
                        "lg": "0px",
                        "xl": "0px",
                        "full": "9999px"
                    },
                    "fontFamily": {
                        "headline": ["Space Grotesk"],
                        "body": ["Inter"],
                        "label": ["Space Grotesk"]
                    }
                },
            },
        }
    </script>
    <style>
        .material-symbols-outlined {
            font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
        }

        .grid-pattern {
            background-image: radial-gradient(circle, #40485d 1px, transparent 1px);
            background-size: 24px 24px;
        }

        .node-active-glow {
            box-shadow: 0 0 15px rgba(129, 236, 255, 0.15);
        }
    </style>
</head>
<body class="bg-surface text-on-surface font-body selection:bg-primary selection:text-on-primary">
    <main class="p-8 min-h-[calc(100vh-64px)] grid-pattern relative overflow-hidden flex flex-col lg:flex-row gap-6">
        <div id="viewport" class="flex-1 relative min-h-[600px] overflow-hidden cursor-grab">
            <div id="canvas" class="absolute inset-0 origin-top-left">
                <svg id="edgesLayer" class="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg"></svg>
                <div id="nodesLayer"></div>
            </div>
        </div>
        <aside id="detailsPanel" class="hidden w-full lg:w-[400px] bg-surface-container-high p-6 flex flex-col gap-8 border-l border-outline-variant/10">
            <div>
                <h2 class="font-headline font-black text-lg tracking-widest mb-6 text-primary flex items-center gap-2">
                    <span class="material-symbols-outlined" data-icon="info">info</span>
                    NODE_DETAILS
                </h2>
                <button id="closePanel" class="absolute top-4 right-4 text-on-surface-variant hover:text-primary">
                    <span class="material-symbols-outlined">close</span>
                </button>
                <div class="space-y-6">
                    <div class="flex flex-col gap-2">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Goal</label>
                        <p id="goalText" class="text-xs bg-surface-container p-3 border-b border-outline-variant/20"></p>
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Assigned Agent</label>
                        <div class="flex items-center gap-4 bg-surface-container p-3">
                            <img alt="Agent Avatar" class="w-10 h-10 object-cover border border-primary/30" data-alt="Futuristic holographic ai agent head profile with digital scanning lines and cool cyan lighting" src="https://lh3.googleusercontent.com/aida-public/AB6AXuBHyJBaLru101be5kCT8V24npSoaGAhHTiZvlv1xnORj2N6ByM3imV1kTuoQD9GS88AgGzADrvY0poHSrbotZQc_Y4PegsbmQS4-gApUrpmfOTvlmwr9yD4cLpsyZ9aAlJy7A17TwNL0kOiLqPTI2tXcXP3L6fhA9Q3vi7Zi5kL9LRi8vIVTZqoRTtcKDwneeImLaM5MV5r1DNm1OZPmg7FuD-LbMUBt_FPaQpXWwYCQ584_qtyobd_CFUlFOJHsA1Z0hcyS6qHYdPy" />
                            <div>
                                <p id="selectedAssignee" class="text-sm font-bold text-on-surface">-</p>
                                <p id="selectedState" class="text-[10px] font-mono text-secondary">ACTIVE STATE: -</p>
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Execution Start</label>
                            <p id="selectedStart" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20">-</p>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Execution End</label>
                            <p id="selectedEnd" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20 text-on-surface-variant">-</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Token Breakdown</label>
                        <div class="space-y-2 bg-surface-container p-4">
                            <div class="flex justify-between text-xs font-mono">
                                <span class="text-on-surface-variant">PROMPT:</span>
                                <span id="selectedPromptTokens" class="text-on-surface">0</span>
                            </div>
                            <div class="flex justify-between text-xs font-mono">
                                <span class="text-on-surface-variant">COMPLETION:</span>
                                <span id="selectedCompletionTokens" class="text-on-surface text-secondary">0</span>
                            </div>
                            <div class="w-full h-1 bg-surface-variant mt-2">
                                <div id="selectedTokenRatio" class="bg-primary h-full w-0"></div>
                            </div>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Tool Calls</label>
                      <p id="selectedToolCalls" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20">0</p>
                    </div>
                </div>
            </div>
            <div class="flex-1 flex flex-col min-h-[200px]">
                <h2 class="font-headline font-black text-[10px] tracking-widest mb-4 text-on-surface-variant">LIVE_AGENT_OUTPUT</h2>
                <div id="liveOutput" class="bg-surface-container-lowest flex-1 p-3 font-mono text-[10px] leading-relaxed overflow-y-auto space-y-1">
                </div>
            </div>
        </aside>
    </main>
    <div class="fixed left-0 top-0 w-1 h-screen bg-gradient-to-b from-primary via-secondary to-tertiary z-[60] opacity-30"></div>
    <script>
        const payload = ${dataJson};
        const canvas = document.getElementById("canvas");
        const viewport = document.getElementById("viewport");
        const edgesLayer = document.getElementById("edgesLayer");
        const nodesLayer = document.getElementById("nodesLayer");
        const goalText = document.getElementById("goalText");
        const liveOutput = document.getElementById("liveOutput");
        const selectedAssignee = document.getElementById("selectedAssignee");
        const selectedState = document.getElementById("selectedState");
        const selectedStart = document.getElementById("selectedStart");
        const selectedToolCalls = document.getElementById("selectedToolCalls");
        const selectedEnd = document.getElementById("selectedEnd");
        const selectedPromptTokens = document.getElementById("selectedPromptTokens");
        const selectedCompletionTokens = document.getElementById("selectedCompletionTokens");
        const selectedTokenRatio = document.getElementById("selectedTokenRatio");
        const svgNs = "http://www.w3.org/2000/svg";

        let scale = 1;
        let translate = { x: 0, y: 0 };

        let isDragging = false;
        let last = { x: 0, y: 0 };

        function updateTransform() {
            canvas.style.transform = \`
                translate(\${translate.x}px, \${translate.y}px)
                scale(\${scale})
            \`;
        }

        viewport.addEventListener("wheel", (e) => {
            e.preventDefault();

            const zoomIntensity = 0.0015;
            const delta = -e.deltaY * zoomIntensity;
            const newScale = Math.min(Math.max(0.4, scale + delta), 2.5);

            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const dx = mouseX - translate.x;
            const dy = mouseY - translate.y;

            translate.x -= dx * (newScale / scale - 1);
            translate.y -= dy * (newScale / scale - 1);
            scale = newScale;
            updateTransform();
        });

        viewport.addEventListener("mousedown", (e) => {
            isDragging = true;
            last = { x: e.clientX, y: e.clientY };
            viewport.classList.add("cursor-grabbing");
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;

            const dx = e.clientX - last.x;
            const dy = e.clientY - last.y;
            translate.x += dx;
            translate.y += dy;
            last = { x: e.clientX, y: e.clientY };
            updateTransform();
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
            viewport.classList.remove("cursor-grabbing");
        });

        updateTransform();

        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        goalText.textContent = payload.goal ?? "";

        const statusStyles = {
            completed: { border: "border-tertiary", icon: "check_circle", iconColor: "text-tertiary", container: "bg-surface-container-lowest node-active-glow", statusColor: "text-on-surface-variant", chip: "STABLE" },
            failed: { border: "border-error", icon: "error", iconColor: "text-error", container: "bg-surface-container-lowest", statusColor: "text-error", chip: "FAILED" },
            blocked: { border: "border-outline", icon: "lock", iconColor: "text-outline", container: "bg-surface-container-low opacity-60 grayscale", statusColor: "text-on-surface-variant", chip: "BLOCKED" },
            skipped: { border: "border-outline", icon: "skip_next", iconColor: "text-outline", container: "bg-surface-container-low opacity-60", statusColor: "text-on-surface-variant", chip: "SKIPPED" },
            in_progress: { border: "border-secondary", icon: "sync", iconColor: "text-secondary", container: "bg-surface-container-low node-active-glow border border-outline-variant/20 shadow-[0_0_20px_rgba(253,192,3,0.1)]", statusColor: "text-secondary", chip: "ACTIVE_STREAM", spin: true },
            pending: { border: "border-outline", icon: "hourglass_empty", iconColor: "text-outline", container: "bg-surface-container-low opacity-60 grayscale", statusColor: "text-on-surface-variant", chip: "WAITING" },
        };

        function durationText(task) {
            const ms = task?.metrics?.durationMs ?? 0;
            const seconds = Math.max(0, ms / 1000).toFixed(1);
            return task.status === "completed" ? "DONE (" + seconds + "s)" : task.status.toUpperCase();
        }

        function layoutTasks(taskList) {
            const byId = new Map(taskList.map((task) => [task.id, task]));
            const children = new Map(taskList.map((task) => [task.id, []]));
            const indegree = new Map();

            for (const task of taskList) {
                const deps = (task.dependsOn || []).filter((dep) => byId.has(dep));
                indegree.set(task.id, deps.length);
                for (const depId of deps) {
                    children.get(depId).push(task.id);
                }
            }

            const levels = new Map();
            const queue = [];
            for (const task of taskList) {
                if ((indegree.get(task.id) ?? 0) === 0) {
                    levels.set(task.id, 0);
                    queue.push(task.id);
                }
            }

            while (queue.length > 0) {
                const currentId = queue.shift();
                const baseLevel = levels.get(currentId) ?? 0;
                for (const childId of children.get(currentId) || []) {
                    const nextLevel = Math.max(levels.get(childId) ?? 0, baseLevel + 1);
                    levels.set(childId, nextLevel);
                    indegree.set(childId, (indegree.get(childId) ?? 1) - 1);
                    if ((indegree.get(childId) ?? 0) === 0) {
                        queue.push(childId);
                    }
                }
            }

            for (const task of taskList) {
                if (!levels.has(task.id)) levels.set(task.id, 0);
            }

            const cols = new Map();
            for (const task of taskList) {
                const level = levels.get(task.id) ?? 0;
                if (!cols.has(level)) cols.set(level, []);
                cols.get(level).push(task);
            }

            const sortedLevels = Array.from(cols.keys()).sort((a, b) => a - b);
            const nodeW = 256;
            const nodeH = 142;
            const colGap = 96;
            const rowGap = 72;
            const padX = 120;
            const padY = 100;
            const positions = new Map();
            let maxRows = 1;
            for (const level of sortedLevels) maxRows = Math.max(maxRows, cols.get(level).length);

            for (const level of sortedLevels) {
                const colTasks = cols.get(level);
                colTasks.forEach((task, idx) => {
                    positions.set(task.id, {
                        x: padX + level * (nodeW + colGap),
                        y: padY + idx * (nodeH + rowGap),
                    });
                });
            }

            const width = Math.max(1600, padX * 2 + sortedLevels.length * (nodeW + colGap));
            const height = Math.max(700, padY * 2 + maxRows * (nodeH + rowGap));
            return { positions, width, height, nodeW, nodeH };
        }

        function renderLiveOutput(taskList) {
            liveOutput.innerHTML = "";
            const finished = taskList.every((task) => ["completed", "failed", "skipped", "blocked"].includes(task.status));
            const header = document.createElement("p");
            header.className = "text-tertiary";
            header.textContent = finished ? "[SYSTEM] Task graph execution finished." : "[SYSTEM] Task graph execution in progress.";
            liveOutput.appendChild(header);

            taskList.forEach((task) => {
                const p = document.createElement("p");
                p.className = task.status === "completed" ? "text-on-surface-variant" : task.status === "failed" ? "text-error" : "text-on-surface-variant";
                p.textContent = "[" + (task.assignee || "UNASSIGNED").toUpperCase() + "] " + task.title + " -> " + task.status.toUpperCase();
                liveOutput.appendChild(p);
            });
        }

        function renderDetails(task) {
            const metrics = task?.metrics ?? {};
            const statusLabel = (statusStyles[task.status] || statusStyles.pending).chip;
            const usage = metrics.tokenUsage ?? { input_tokens: 0, output_tokens: 0 };
            const inTokens = usage.input_tokens ?? 0;
            const outTokens = usage.output_tokens ?? 0;
            const total = inTokens + outTokens;
            const ratio = total > 0 ? Math.round((inTokens / total) * 100) : 0;

            selectedAssignee.textContent = task?.assignee || "UNASSIGNED";

            selectedState.textContent = "STATE: " + statusLabel;
            selectedStart.textContent = metrics.startMs ? new Date(metrics.startMs).toISOString() : "-";
            selectedEnd.textContent = metrics.endMs ? new Date(metrics.endMs).toISOString() : "-";

            selectedToolCalls.textContent = (metrics.toolCalls ?? []).length.toString();

            selectedPromptTokens.textContent = inTokens.toLocaleString();
            selectedCompletionTokens.textContent = outTokens.toLocaleString();
            selectedTokenRatio.style.width = ratio + "%";
        }

        function makeEdgePath(x1, y1, x2, y2) {
            return "M " + x1 + " " + y1 + " C " + (x1 + 42) + " " + y1 + ", " + (x2 - 42) + " " + y2 + ", " + x2 + " " + y2;
        }

        function renderDag(taskList) {
            const { positions, width, height, nodeW, nodeH } = layoutTasks(taskList);
            canvas.style.width = width + "px";
            canvas.style.height = height + "px";

            edgesLayer.setAttribute("viewBox", "0 0 " + width + " " + height);
            edgesLayer.innerHTML = "";
            const defs = document.createElementNS(svgNs, "defs");
            const marker = document.createElementNS(svgNs, "marker");
            marker.setAttribute("id", "arrow");
            marker.setAttribute("markerWidth", "8");
            marker.setAttribute("markerHeight", "8");
            marker.setAttribute("refX", "7");
            marker.setAttribute("refY", "4");
            marker.setAttribute("orient", "auto");
            const markerPath = document.createElementNS(svgNs, "path");
            markerPath.setAttribute("d", "M0,0 L8,4 L0,8 z");
            markerPath.setAttribute("fill", "#40485d");
            marker.appendChild(markerPath);
            defs.appendChild(marker);
            edgesLayer.appendChild(defs);

            taskList.forEach((task) => {
                const to = positions.get(task.id);
                (task.dependsOn || []).forEach((depId) => {
                    const from = positions.get(depId);
                    if (!from || !to) return;
                    const edge = document.createElementNS(svgNs, "path");
                    edge.setAttribute("d", makeEdgePath(from.x + nodeW, from.y + nodeH / 2, to.x, to.y + nodeH / 2));
                    edge.setAttribute("fill", "none");
                    edge.setAttribute("stroke", "#40485d");
                    edge.setAttribute("stroke-width", "2");
                    edge.setAttribute("marker-end", "url(#arrow)");
                    edgesLayer.appendChild(edge);
                });
            });

            nodesLayer.innerHTML = "";
            taskList.forEach((task, idx) => {
                const pos = positions.get(task.id);
                const status = statusStyles[task.status] || statusStyles.pending;
                const nodeId = "#NODE_" + String(idx + 1).padStart(3, "0");
                const chips = [task.assignee ? task.assignee.toUpperCase() : "UNASSIGNED", status.chip];

                const node = document.createElement("div");
                node.className = "node absolute w-64 border-l-2 p-4 cursor-pointer " + status.border + " " + status.container;
                node.style.left = pos.x + "px";
                node.style.top = pos.y + "px";
                node.innerHTML = \`
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-[10px] font-mono \${status.iconColor}">\${nodeId}</span>
                        <span class="material-symbols-outlined \${status.iconColor} text-lg \${status.spin ? "animate-spin" : ""}" data-icon="\${status.icon}">\${status.icon}</span>
                    </div>
                    <h3 class="font-headline font-bold text-sm tracking-tight mb-1">\${task.title}</h3>
                    <p class="text-xs \${status.statusColor} mb-4">STATUS: \${durationText(task)}</p>
                    <div class="flex gap-2">
                        \${chips.map((chip) => '<span class="px-2 py-0.5 bg-surface-variant text-[9px] font-mono text-on-surface-variant">' + chip + '</span>').join("")}
                    </div>
                \`;
                node.addEventListener("click", () => {
                    renderDetails(task);
                    panel.classList.remove("hidden");
                });
                nodesLayer.appendChild(node);
            });

            renderLiveOutput(taskList);
        }

        renderDag(tasks);
    </script>
    <script>
        const panel = document.getElementById("detailsPanel");
        const closeBtn = document.getElementById("closePanel");
        const nodes = document.querySelectorAll(".node");

        nodes.forEach((node) => {
            node.addEventListener("click", () => {
                panel.classList.remove("hidden");
            });
        });

        closeBtn.addEventListener("click", () => {
            panel.classList.add("hidden");
        });

        document.addEventListener("click", (e) => {
            const isClickInsidePanel = panel.contains(e.target);
            const isNode = e.target.closest(".node");

            if (!isClickInsidePanel && !isNode) {
                panel.classList.add("hidden");
            }
        });
    </script>
</body>
</html>`
}

async function writeRunTeamDashboard(goal: string, tasks: DashboardTaskNode[]): Promise<string> {
  const directory = join(process.cwd(), 'oma-dashboards')
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const path = join(directory, `runTeam-${stamp}.html`)
  await writeFile(path, buildRunTeamDashboardHtml(goal, tasks), 'utf8')
  return path
}

/**
 * Build a minimal {@link Agent} with its own fresh registry/executor.
 * Registers all built-in tools so coordinator/worker agents can use them.
 */
function buildAgent(config: AgentConfig): Agent {
  const registry = new ToolRegistry()
  registerBuiltInTools(registry)
  if (config.customTools) {
    for (const tool of config.customTools) {
      registry.register(tool, { runtimeAdded: true })
    }
  }
  const executor = new ToolExecutor(registry)
  return new Agent(config, registry, executor)
}

/** Promise-based delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Maximum delay cap to prevent runaway exponential backoff (30 seconds). */
const MAX_RETRY_DELAY_MS = 30_000

/**
 * Compute the retry delay for a given attempt, capped at {@link MAX_RETRY_DELAY_MS}.
 */
export function computeRetryDelay(
  baseDelay: number,
  backoff: number,
  attempt: number,
): number {
  return Math.min(baseDelay * backoff ** (attempt - 1), MAX_RETRY_DELAY_MS)
}

/**
 * Execute an agent task with optional retry and exponential backoff.
 *
 * Exported for testability — called internally by {@link executeQueue}.
 *
 * @param run      - The function that executes the task (typically `pool.run`).
 * @param task     - The task to execute (retry config read from its fields).
 * @param onRetry  - Called before each retry sleep with event data.
 * @param delayFn  - Injectable delay function (defaults to real `sleep`).
 * @returns The final {@link AgentRunResult} from the last attempt.
 */
export async function executeWithRetry(
  run: () => Promise<AgentRunResult>,
  task: Task,
  onRetry?: (data: { attempt: number; maxAttempts: number; error: string; nextDelayMs: number }) => void,
  delayFn: (ms: number) => Promise<void> = sleep,
): Promise<AgentRunResult> {
  const rawRetries = Number.isFinite(task.maxRetries) ? task.maxRetries! : 0
  const maxAttempts = Math.max(0, rawRetries) + 1
  const baseDelay = Math.max(0, Number.isFinite(task.retryDelayMs) ? task.retryDelayMs! : 1000)
  const backoff = Math.max(1, Number.isFinite(task.retryBackoff) ? task.retryBackoff! : 2)

  let lastError: string = ''
  // Accumulate token usage across all attempts so billing/observability
  // reflects the true cost of retries.
  let totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run()
      totalUsage = {
        input_tokens: totalUsage.input_tokens + result.tokenUsage.input_tokens,
        output_tokens: totalUsage.output_tokens + result.tokenUsage.output_tokens,
      }

      if (result.success) {
        return { ...result, tokenUsage: totalUsage }
      }
      lastError = result.output

      // Failure — retry or give up
      if (attempt < maxAttempts) {
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        await delayFn(delay)
        continue
      }

      return { ...result, tokenUsage: totalUsage }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)

      if (attempt < maxAttempts) {
        const delay = computeRetryDelay(baseDelay, backoff, attempt)
        onRetry?.({ attempt, maxAttempts, error: lastError, nextDelayMs: delay })
        await delayFn(delay)
        continue
      }

      // All retries exhausted — return a failure result
      return {
        success: false,
        output: lastError,
        messages: [],
        tokenUsage: totalUsage,
        toolCalls: [],
      }
    }
  }

  // Should not be reached, but TypeScript needs a return
  return {
    success: false,
    output: lastError,
    messages: [],
    tokenUsage: totalUsage,
    toolCalls: [],
  }
}

// ---------------------------------------------------------------------------
// Parsed task spec (result of coordinator decomposition)
// ---------------------------------------------------------------------------

interface ParsedTaskSpec {
  title: string
  description: string
  assignee?: string
  dependsOn?: string[]
  memoryScope?: 'dependencies' | 'all'
  maxRetries?: number
  retryDelayMs?: number
  retryBackoff?: number
}

/**
 * Attempt to extract a JSON array of task specs from the coordinator's raw
 * output. The coordinator is prompted to emit JSON inside a ```json … ``` fence
 * or as a bare array. Returns `null` when no valid array can be extracted.
 */
function parseTaskSpecs(raw: string): ParsedTaskSpec[] | null {
  // Strategy 1: look for a fenced JSON block
  const fenceMatch = raw.match(/```json\s*([\s\S]*?)```/)
  const candidate = fenceMatch ? fenceMatch[1]! : raw

  // Strategy 2: find the first '[' and last ']'
  const arrayStart = candidate.indexOf('[')
  const arrayEnd = candidate.lastIndexOf(']')
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    return null
  }

  const jsonSlice = candidate.slice(arrayStart, arrayEnd + 1)
  try {
    const parsed: unknown = JSON.parse(jsonSlice)
    if (!Array.isArray(parsed)) return null

    const specs: ParsedTaskSpec[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const obj = item as Record<string, unknown>
      if (typeof obj['title'] !== 'string') continue
      if (typeof obj['description'] !== 'string') continue

      specs.push({
        title: obj['title'],
        description: obj['description'],
        assignee: typeof obj['assignee'] === 'string' ? obj['assignee'] : undefined,
        dependsOn: Array.isArray(obj['dependsOn'])
          ? (obj['dependsOn'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined,
        memoryScope: obj['memoryScope'] === 'all' ? 'all' : undefined,
        maxRetries: typeof obj['maxRetries'] === 'number' ? obj['maxRetries'] : undefined,
        retryDelayMs: typeof obj['retryDelayMs'] === 'number' ? obj['retryDelayMs'] : undefined,
        retryBackoff: typeof obj['retryBackoff'] === 'number' ? obj['retryBackoff'] : undefined,
      })
    }

    return specs.length > 0 ? specs : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestration loop
// ---------------------------------------------------------------------------

/**
 * Internal execution context assembled once per `runTeam` / `runTasks` call.
 */
interface RunContext {
  readonly team: Team
  readonly pool: AgentPool
  readonly scheduler: Scheduler
  readonly agentResults: Map<string, AgentRunResult>
  readonly config: OrchestratorConfig
  /** Trace run ID, present when `onTrace` is configured. */
  readonly runId?: string
  /** AbortSignal for run-level cancellation. Checked between task dispatch rounds. */
  readonly abortSignal?: AbortSignal
  cumulativeUsage: TokenUsage
  readonly maxTokenBudget?: number
  budgetExceededTriggered: boolean
  budgetExceededReason?: string
  readonly taskMetrics: Map<string, DashboardTaskMetrics>
}

/**
 * Execute all tasks in `queue` using agents in `pool`, respecting dependencies
 * and running independent tasks in parallel.
 *
 * The orchestration loop works in rounds:
 *  1. Find all `'pending'` tasks (dependencies satisfied).
 *  2. Dispatch them in parallel via the pool.
 *  3. On completion, the queue automatically unblocks dependents.
 *  4. Repeat until no more pending tasks exist or all remaining tasks are
 *     `'failed'`/`'blocked'` (stuck).
 */
async function executeQueue(
  queue: TaskQueue,
  ctx: RunContext,
): Promise<void> {
  const { team, pool, scheduler, config } = ctx

  // Relay queue-level skip events to the orchestrator's onProgress callback.
  const unsubSkipped = config.onProgress
    ? queue.on('task:skipped', (task) => {
        config.onProgress!({
          type: 'task_skipped',
          task: task.id,
          data: task,
        } satisfies OrchestratorEvent)
      })
    : undefined

  while (true) {
    // Check for cancellation before each dispatch round.
    if (ctx.abortSignal?.aborted) {
      queue.skipRemaining('Skipped: run aborted.')
      break
    }

    // Re-run auto-assignment each iteration so tasks that were unblocked since
    // the last round (and thus have no assignee yet) get assigned before dispatch.
    scheduler.autoAssign(queue, team.getAgents())

    const pending = queue.getByStatus('pending')
    if (pending.length === 0) {
      // Either all done, or everything remaining is blocked/failed.
      break
    }

    // Track tasks that complete successfully in this round for the approval gate.
    // Safe to push from concurrent promises: JS is single-threaded, so
    // Array.push calls from resolved microtasks never interleave.
    const completedThisRound: Task[] = []

    // Dispatch all currently-pending tasks as a parallel batch.
    const dispatchPromises = pending.map(async (task): Promise<void> => {
      // Mark in-progress
      queue.update(task.id, { status: 'in_progress' as TaskStatus })

      const assignee = task.assignee
      if (!assignee) {
        // No assignee — mark failed and continue
        const msg = `Task "${task.title}" has no assignee.`
        queue.fail(task.id, msg)
        config.onProgress?.({
          type: 'error',
          task: task.id,
          data: msg,
        } satisfies OrchestratorEvent)
        return
      }

      const agent = pool.get(assignee)
      if (!agent) {
        const msg = `Agent "${assignee}" not found in pool for task "${task.title}".`
        queue.fail(task.id, msg)
        config.onProgress?.({
          type: 'error',
          task: task.id,
          agent: assignee,
          data: msg,
        } satisfies OrchestratorEvent)
        return
      }

      config.onProgress?.({
        type: 'task_start',
        task: task.id,
        agent: assignee,
        data: task,
      } satisfies OrchestratorEvent)

      config.onProgress?.({
        type: 'agent_start',
        agent: assignee,
        task: task.id,
        data: task,
      } satisfies OrchestratorEvent)

      // Build the prompt: task description + dependency-only context by default.
      const prompt = await buildTaskPrompt(task, team, queue)

      // Build trace context for this task's agent run
      const traceOptions: Partial<RunOptions> | undefined = config.onTrace
        ? { onTrace: config.onTrace, runId: ctx.runId ?? '', taskId: task.id, traceAgent: assignee, abortSignal: ctx.abortSignal }
        : ctx.abortSignal ? { abortSignal: ctx.abortSignal } : undefined

      const taskStartMs = Date.now()
      let retryCount = 0

      const result = await executeWithRetry(
        () => pool.run(assignee, prompt, traceOptions),
        task,
        (retryData) => {
          retryCount++
          config.onProgress?.({
            type: 'task_retry',
            task: task.id,
            agent: assignee,
            data: retryData,
          } satisfies OrchestratorEvent)
        },
      )

      const taskEndMs = Date.now()

      // Emit task trace
      if (config.onTrace) {
        emitTrace(config.onTrace, {
          type: 'task',
          runId: ctx.runId ?? '',
          taskId: task.id,
          taskTitle: task.title,
          agent: assignee,
          success: result.success,
          retries: retryCount,
          startMs: taskStartMs,
          endMs: taskEndMs,
          durationMs: taskEndMs - taskStartMs,
        })
      }

      ctx.agentResults.set(`${assignee}:${task.id}`, result)

      ctx.taskMetrics.set(task.id, {
        startMs: taskStartMs,
        endMs: taskEndMs,
        durationMs: Math.max(0, taskEndMs - taskStartMs),
        tokenUsage: result.tokenUsage,
        toolCalls: result.toolCalls,
      })
      ctx.cumulativeUsage = addUsage(ctx.cumulativeUsage, result.tokenUsage)
      const totalTokens = ctx.cumulativeUsage.input_tokens + ctx.cumulativeUsage.output_tokens
      if (
        !ctx.budgetExceededTriggered
        && ctx.maxTokenBudget !== undefined
        && totalTokens > ctx.maxTokenBudget
      ) {
        ctx.budgetExceededTriggered = true
        const err = new TokenBudgetExceededError('orchestrator', totalTokens, ctx.maxTokenBudget)
        ctx.budgetExceededReason = err.message
        config.onProgress?.({
          type: 'budget_exceeded',
          agent: assignee,
          task: task.id,
          data: err,
        } satisfies OrchestratorEvent)
      }

      if (result.success) {
        // Persist result into shared memory so other agents can read it
        const sharedMem = team.getSharedMemoryInstance()
        if (sharedMem) {
          await sharedMem.write(assignee, `task:${task.id}:result`, result.output)
        }

        const completedTask = queue.complete(task.id, result.output)
        completedThisRound.push(completedTask)

        config.onProgress?.({
          type: 'task_complete',
          task: task.id,
          agent: assignee,
          data: result,
        } satisfies OrchestratorEvent)

        config.onProgress?.({
          type: 'agent_complete',
          agent: assignee,
          task: task.id,
          data: result,
        } satisfies OrchestratorEvent)
      } else {
        queue.fail(task.id, result.output)
        config.onProgress?.({
          type: 'error',
          task: task.id,
          agent: assignee,
          data: result,
        } satisfies OrchestratorEvent)
      }
    })

    // Wait for the entire parallel batch before checking for newly-unblocked tasks.
    await Promise.all(dispatchPromises)
    if (ctx.budgetExceededTriggered) {
      queue.skipRemaining(ctx.budgetExceededReason ?? 'Skipped: token budget exceeded.')
      break
    }

    // --- Approval gate ---
    // After the batch completes, check if the caller wants to approve
    // the next round before it starts.
    if (config.onApproval && completedThisRound.length > 0) {
      scheduler.autoAssign(queue, team.getAgents())
      const nextPending = queue.getByStatus('pending')

      if (nextPending.length > 0) {
        let approved: boolean
        try {
          approved = await config.onApproval(completedThisRound, nextPending)
        } catch (err) {
          const reason = `Skipped: approval callback error — ${err instanceof Error ? err.message : String(err)}`
          queue.skipRemaining(reason)
          break
        }
        if (!approved) {
          queue.skipRemaining('Skipped: approval rejected.')
          break
        }
      }
    }
  }

  unsubSkipped?.()
}

/**
 * Build the agent prompt for a specific task.
 *
 * Injects:
 *  - Task title and description
 *  - Direct dependency task results by default (clean slate when none)
 *  - Optional full shared-memory context when `task.memoryScope === 'all'`
 *  - Any messages addressed to this agent from the team bus
 */
async function buildTaskPrompt(task: Task, team: Team, queue: TaskQueue): Promise<string> {
  const lines: string[] = [
    `# Task: ${task.title}`,
    '',
    task.description,
  ]

  if (task.memoryScope === 'all') {
    // Explicit opt-in for full visibility (legacy/shared-memory behavior).
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      const summary = await sharedMem.getSummary()
      if (summary) {
        lines.push('', summary)
      }
    }
  } else if (task.dependsOn && task.dependsOn.length > 0) {
    // Default-deny: inject only explicit prerequisite outputs.
    const depResults: string[] = []
    for (const depId of task.dependsOn) {
      const depTask = queue.get(depId)
      if (depTask?.status === 'completed' && depTask.result) {
        depResults.push(`### ${depTask.title} (by ${depTask.assignee ?? 'unknown'})\n${depTask.result}`)
      }
    }
    if (depResults.length > 0) {
      lines.push('', '## Context from prerequisite tasks', '', ...depResults)
    }
  }

  // Inject messages from other agents addressed to this assignee
  if (task.assignee) {
    const messages = team.getMessages(task.assignee)
    if (messages.length > 0) {
      lines.push('', '## Messages from team members')
      for (const msg of messages) {
        lines.push(`- **${msg.from}**: ${msg.content}`)
      }
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// OpenMultiAgent
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator for the open-multi-agent framework.
 *
 * Manages teams, coordinates task execution, and surfaces progress events.
 * Most users will interact with this class exclusively.
 */
export class OpenMultiAgent {
  private readonly config: Required<
    Omit<OrchestratorConfig, 'onApproval' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget'>
  > & Pick<OrchestratorConfig, 'onApproval' | 'onProgress' | 'onTrace' | 'defaultBaseURL' | 'defaultApiKey' | 'maxTokenBudget'>

  private readonly teams: Map<string, Team> = new Map()
  private completedTaskCount = 0

  private async emitRunTeamDashboard(
    goal: string,
    tasks: Task[],
    taskMetrics: Map<string, DashboardTaskMetrics>,
  ): Promise<void> {
    const dashboardTasks: DashboardTaskNode[] = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      status: task.status,
      dependsOn: task.dependsOn ?? [],
      metrics: taskMetrics.get(task.id),
    }))
    const htmlPath = await writeRunTeamDashboard(goal, dashboardTasks)
    this.config.onProgress?.({
      type: 'message',
      data: { kind: 'runTeam_dashboard', path: htmlPath },
    } satisfies OrchestratorEvent)
  }

  /**
   * @param config - Optional top-level configuration.
   *
   * Sensible defaults:
   *   - `maxConcurrency`: 5
   *   - `defaultModel`:   `'claude-opus-4-6'`
   *   - `defaultProvider`: `'anthropic'`
   */
  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      defaultProvider: config.defaultProvider ?? 'anthropic',
      defaultBaseURL: config.defaultBaseURL,
      defaultApiKey: config.defaultApiKey,
      maxTokenBudget: config.maxTokenBudget,
      onApproval: config.onApproval,
      onProgress: config.onProgress,
      onTrace: config.onTrace,
    }
  }

  // -------------------------------------------------------------------------
  // Team management
  // -------------------------------------------------------------------------

  /**
   * Create and register a {@link Team} with the orchestrator.
   *
   * The team is stored internally so {@link getStatus} can report aggregate
   * agent counts. Returns the new {@link Team} for further configuration.
   *
   * @param name   - Unique team identifier. Throws if already registered.
   * @param config - Team configuration (agents, shared memory, concurrency).
   */
  createTeam(name: string, config: TeamConfig): Team {
    if (this.teams.has(name)) {
      throw new Error(
        `OpenMultiAgent: a team named "${name}" already exists. ` +
        `Use a unique name or call shutdown() to clear all teams.`,
      )
    }
    const team = new Team(config)
    this.teams.set(name, team)
    return team
  }

  // -------------------------------------------------------------------------
  // Single-agent convenience
  // -------------------------------------------------------------------------

  /**
   * Run a single prompt with a one-off agent.
   *
   * Constructs a fresh agent from `config`, runs `prompt` in a single turn,
   * and returns the result. The agent is not registered with any pool or team.
   *
   * Useful for simple one-shot queries that do not need team orchestration.
   *
   * @param config - Agent configuration.
   * @param prompt - The user prompt to send.
   */
  async runAgent(
    config: AgentConfig,
    prompt: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<AgentRunResult> {
    const effectiveBudget = resolveTokenBudget(config.maxTokenBudget, this.config.maxTokenBudget)
    const effective: AgentConfig = {
      ...config,
      provider: config.provider ?? this.config.defaultProvider,
      baseURL: config.baseURL ?? this.config.defaultBaseURL,
      apiKey: config.apiKey ?? this.config.defaultApiKey,
      maxTokenBudget: effectiveBudget,
    }
    const agent = buildAgent(effective)
    this.config.onProgress?.({
      type: 'agent_start',
      agent: config.name,
      data: { prompt },
    })

    // Build run-time options: trace + optional abort signal. RunOptions has
    // readonly fields, so we assemble the literal in one shot.
    const traceFields = this.config.onTrace
      ? {
          onTrace: this.config.onTrace,
          runId: generateRunId(),
          traceAgent: config.name,
        }
      : null
    const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
    const runOptions: Partial<RunOptions> | undefined =
      traceFields || abortFields
        ? { ...(traceFields ?? {}), ...(abortFields ?? {}) }
        : undefined

    const result = await agent.run(prompt, runOptions)

    if (result.budgetExceeded) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: config.name,
        data: new TokenBudgetExceededError(
          config.name,
          result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
          effectiveBudget ?? 0,
        ),
      })
    }

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: config.name,
      data: result,
    })

    if (result.success) {
      this.completedTaskCount++
    }

    return result
  }

  // -------------------------------------------------------------------------
  // Auto-orchestrated team run (KILLER FEATURE)
  // -------------------------------------------------------------------------

  /**
   * Run a team on a high-level goal with full automatic orchestration.
   *
   * This is the flagship method of the framework. It works as follows:
   *
   * 1. A temporary "coordinator" agent receives the goal and the team's agent
   *    roster, and is asked to decompose it into an ordered list of tasks with
   *    JSON output.
   * 2. The tasks are loaded into a {@link TaskQueue}. Title-based dependency
   *    tokens in the coordinator's output are resolved to task IDs.
   * 3. The {@link Scheduler} assigns unassigned tasks to team agents.
   * 4. Tasks are executed in dependency order, with independent tasks running
   *    in parallel up to `maxConcurrency`.
   * 5. Results are persisted to shared memory after each task so subsequent
   *    agents can read them.
   * 6. The coordinator synthesises a final answer from all task outputs.
   * 7. A {@link TeamRunResult} is returned.
   *
   * @param team - A team created via {@link createTeam} (or `new Team(...)`).
   * @param goal - High-level natural-language goal for the team.
   */
  async runTeam(
    team: Team,
    goal: string,
    options?: { abortSignal?: AbortSignal; coordinator?: CoordinatorConfig },
  ): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()
    const coordinatorOverrides = options?.coordinator

    // ------------------------------------------------------------------
    // Short-circuit: skip coordinator for simple, single-action goals.
    //
    // When the goal is short and contains no multi-step / coordination
    // signals, dispatching it to a single agent is faster and cheaper
    // than spinning up a coordinator for decomposition + synthesis.
    //
    // The best-matching agent is selected via keyword affinity scoring
    // (same algorithm as the `capability-match` scheduler strategy).
    // ------------------------------------------------------------------
    if (agentConfigs.length > 0 && isSimpleGoal(goal)) {
      const bestAgent = selectBestAgent(goal, agentConfigs)

      // Use buildAgent() + agent.run() directly instead of this.runAgent()
      // to avoid duplicate progress events and double completedTaskCount.
      // Events are emitted here; counting is handled by buildTeamRunResult().
      const effectiveBudget = resolveTokenBudget(bestAgent.maxTokenBudget, this.config.maxTokenBudget)
      const effective: AgentConfig = {
        ...bestAgent,
        provider: bestAgent.provider ?? this.config.defaultProvider,
        baseURL: bestAgent.baseURL ?? this.config.defaultBaseURL,
        apiKey: bestAgent.apiKey ?? this.config.defaultApiKey,
        maxTokenBudget: effectiveBudget,
      }
      const agent = buildAgent(effective)

      this.config.onProgress?.({
        type: 'agent_start',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', goal },
      })

      const traceFields = this.config.onTrace
        ? { onTrace: this.config.onTrace, runId: generateRunId(), traceAgent: bestAgent.name }
        : null
      const abortFields = options?.abortSignal ? { abortSignal: options.abortSignal } : null
      const runOptions: Partial<RunOptions> | undefined =
        traceFields || abortFields
          ? { ...(traceFields ?? {}), ...(abortFields ?? {}) }
          : undefined

      const scStartMs = Date.now()
      
      const result = await agent.run(goal, runOptions)
      
      const scEndMs = Date.now()

      if (result.budgetExceeded) {
        this.config.onProgress?.({
          type: 'budget_exceeded',
          agent: bestAgent.name,
          data: new TokenBudgetExceededError(
            bestAgent.name,
            result.tokenUsage.input_tokens + result.tokenUsage.output_tokens,
            effectiveBudget ?? 0,
          ),
        })
      }

      this.config.onProgress?.({
        type: 'agent_complete',
        agent: bestAgent.name,
        data: { phase: 'short-circuit', result },
      })

      const agentResults = new Map<string, AgentRunResult>()
      agentResults.set(bestAgent.name, result)


      await this.emitRunTeamDashboard(
        goal,
        [{
          id: 'short-circuit',
          title: `Short-circuit: ${bestAgent.name}`,
          description: goal,
          status: result.success ? 'completed' : 'failed',
          assignee: bestAgent.name,
          dependsOn: [],
          result: result.output,
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
        new Map<string, DashboardTaskMetrics>([
          ['short-circuit', {
            startMs: scStartMs,
            endMs: scEndMs,
            durationMs: scEndMs - scStartMs,
            tokenUsage: result.tokenUsage,
            toolCalls: result.toolCalls,
          }],
        ]),
      )
      return this.buildTeamRunResult(agentResults)
    }

    // ------------------------------------------------------------------
    // Step 1: Coordinator decomposes goal into tasks
    // ------------------------------------------------------------------
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      model: coordinatorOverrides?.model ?? this.config.defaultModel,
      provider: coordinatorOverrides?.provider ?? this.config.defaultProvider,
      baseURL: coordinatorOverrides?.baseURL ?? this.config.defaultBaseURL,
      apiKey: coordinatorOverrides?.apiKey ?? this.config.defaultApiKey,
      systemPrompt: this.buildCoordinatorPrompt(agentConfigs, coordinatorOverrides),
      maxTurns: coordinatorOverrides?.maxTurns ?? 3,
      maxTokens: coordinatorOverrides?.maxTokens,
      temperature: coordinatorOverrides?.temperature,
      toolPreset: coordinatorOverrides?.toolPreset,
      tools: coordinatorOverrides?.tools,
      disallowedTools: coordinatorOverrides?.disallowedTools,
      loopDetection: coordinatorOverrides?.loopDetection,
      timeoutMs: coordinatorOverrides?.timeoutMs,
    }

    const decompositionPrompt = this.buildDecompositionPrompt(goal, agentConfigs)
    const coordinatorAgent = buildAgent(coordinatorConfig)
    const runId = this.config.onTrace ? generateRunId() : undefined

    this.config.onProgress?.({
      type: 'agent_start',
      agent: 'coordinator',
      data: { phase: 'decomposition', goal },
    })

    const decompTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator', abortSignal: options?.abortSignal }
      : options?.abortSignal ? { abortSignal: options.abortSignal } : undefined
    const decompositionResult = await coordinatorAgent.run(decompositionPrompt, decompTraceOptions)
    const agentResults = new Map<string, AgentRunResult>()
    agentResults.set('coordinator:decompose', decompositionResult)
    const maxTokenBudget = this.config.maxTokenBudget
    let cumulativeUsage = addUsage(ZERO_USAGE, decompositionResult.tokenUsage)

    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: 'coordinator',
        data: new TokenBudgetExceededError(
          'coordinator',
          cumulativeUsage.input_tokens + cumulativeUsage.output_tokens,
          maxTokenBudget,
        ),
      })
      await this.emitRunTeamDashboard(goal, [], new Map<string, DashboardTaskMetrics>())
      return this.buildTeamRunResult(agentResults)
    }

    // ------------------------------------------------------------------
    // Step 2: Parse tasks from coordinator output
    // ------------------------------------------------------------------
    const taskSpecs = parseTaskSpecs(decompositionResult.output)

    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')
    const taskMetrics = new Map<string, DashboardTaskMetrics>()

    if (taskSpecs && taskSpecs.length > 0) {
      // Map title-based dependsOn references to real task IDs so we can
      // build the dependency graph before adding tasks to the queue.
      this.loadSpecsIntoQueue(taskSpecs, agentConfigs, queue)
    } else {
      // Coordinator failed to produce structured output — fall back to
      // one task per agent using the goal as the description.
      for (const agentConfig of agentConfigs) {
        const task = createTask({
          title: `${agentConfig.name}: ${goal.slice(0, 80)}`,
          description: goal,
          assignee: agentConfig.name,
        })
        queue.add(task)
      }
    }

    // ------------------------------------------------------------------
    // Step 3: Auto-assign any unassigned tasks
    // ------------------------------------------------------------------
    scheduler.autoAssign(queue, agentConfigs)

    // ------------------------------------------------------------------
    // Step 4: Build pool and execute
    // ------------------------------------------------------------------
    const pool = this.buildPool(agentConfigs)
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId,
      abortSignal: options?.abortSignal,
      cumulativeUsage,
      maxTokenBudget,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics,
    }

    await executeQueue(queue, ctx)
    cumulativeUsage = ctx.cumulativeUsage
    await this.emitRunTeamDashboard(goal, queue.list(), taskMetrics)

    // ------------------------------------------------------------------
    // Step 5: Coordinator synthesises final result
    // ------------------------------------------------------------------
    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      return this.buildTeamRunResult(agentResults)
    }
    const synthesisPrompt = await this.buildSynthesisPrompt(goal, queue.list(), team)
    const synthTraceOptions: Partial<RunOptions> | undefined = this.config.onTrace
      ? { onTrace: this.config.onTrace, runId: runId ?? '', traceAgent: 'coordinator' }
      : undefined
    const synthesisResult = await coordinatorAgent.run(synthesisPrompt, synthTraceOptions)
    agentResults.set('coordinator', synthesisResult)
    cumulativeUsage = addUsage(cumulativeUsage, synthesisResult.tokenUsage)
    if (
      maxTokenBudget !== undefined
      && cumulativeUsage.input_tokens + cumulativeUsage.output_tokens > maxTokenBudget
    ) {
      this.config.onProgress?.({
        type: 'budget_exceeded',
        agent: 'coordinator',
        data: new TokenBudgetExceededError(
          'coordinator',
          cumulativeUsage.input_tokens + cumulativeUsage.output_tokens,
          maxTokenBudget,
        ),
      })
    }

    this.config.onProgress?.({
      type: 'agent_complete',
      agent: 'coordinator',
      data: synthesisResult,
    })

    // Note: coordinator decompose and synthesis are internal meta-steps.
    // Only actual user tasks (non-coordinator keys) are counted in
    // buildTeamRunResult, so we do not increment completedTaskCount here.

    return this.buildTeamRunResult(agentResults)
  }

  // -------------------------------------------------------------------------
  // Explicit-task team run
  // -------------------------------------------------------------------------

  /**
   * Run a team with an explicitly provided task list.
   *
   * Simpler than {@link runTeam}: no coordinator agent is involved. Tasks are
   * loaded directly into the queue, unassigned tasks are auto-assigned via the
   * {@link Scheduler}, and execution proceeds in dependency order.
   *
   * @param team  - A team created via {@link createTeam}.
   * @param tasks - Array of task descriptors.
   */
  async runTasks(
    team: Team,
    tasks: ReadonlyArray<{
      title: string
      description: string
      assignee?: string
      dependsOn?: string[]
      memoryScope?: 'dependencies' | 'all'
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    options?: { abortSignal?: AbortSignal },
  ): Promise<TeamRunResult> {
    const agentConfigs = team.getAgents()
    const queue = new TaskQueue()
    const scheduler = new Scheduler('dependency-first')

    this.loadSpecsIntoQueue(
      tasks.map((t) => ({
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        dependsOn: t.dependsOn,
        memoryScope: t.memoryScope,
        maxRetries: t.maxRetries,
        retryDelayMs: t.retryDelayMs,
        retryBackoff: t.retryBackoff,
      })),
      agentConfigs,
      queue,
    )

    scheduler.autoAssign(queue, agentConfigs)

    const pool = this.buildPool(agentConfigs)
    const agentResults = new Map<string, AgentRunResult>()
    const ctx: RunContext = {
      team,
      pool,
      scheduler,
      agentResults,
      config: this.config,
      runId: this.config.onTrace ? generateRunId() : undefined,
      abortSignal: options?.abortSignal,
      cumulativeUsage: ZERO_USAGE,
      maxTokenBudget: this.config.maxTokenBudget,
      budgetExceededTriggered: false,
      budgetExceededReason: undefined,
      taskMetrics: new Map<string, DashboardTaskMetrics>(),
    }

    await executeQueue(queue, ctx)

    return this.buildTeamRunResult(agentResults)
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  /**
   * Returns a lightweight status snapshot.
   *
   * - `teams`          — Number of teams registered with this orchestrator.
   * - `activeAgents`   — Total agents currently in `running` state.
   * - `completedTasks` — Cumulative count of successfully completed tasks
   *                      (coordinator meta-steps excluded).
   */
  getStatus(): { teams: number; activeAgents: number; completedTasks: number } {
    return {
      teams: this.teams.size,
      activeAgents: 0, // Pools are ephemeral per-run; no cross-run state to inspect.
      completedTasks: this.completedTaskCount,
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Deregister all teams and reset internal counters.
   *
   * Does not cancel in-flight runs. Call this when you want to reuse the
   * orchestrator instance for a fresh set of teams.
   *
   * Async for forward compatibility — shutdown may need to perform async
   * cleanup (e.g. graceful agent drain) in future versions.
   */
  async shutdown(): Promise<void> {
    this.teams.clear()
    this.completedTaskCount = 0
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Build the system prompt given to the coordinator agent. */
  private buildCoordinatorSystemPrompt(agents: AgentConfig[]): string {
    return [
      'You are a task coordinator responsible for decomposing high-level goals',
      'into concrete, actionable tasks and assigning them to the right team members.',
      '',
      this.buildCoordinatorRosterSection(agents),
      '',
      this.buildCoordinatorOutputFormatSection(),
      '',
      this.buildCoordinatorSynthesisSection(),
    ].join('\n')
  }

  /** Build coordinator system prompt with optional caller overrides. */
  private buildCoordinatorPrompt(agents: AgentConfig[], config?: CoordinatorConfig): string {
    if (config?.systemPrompt) {
      return [
        config.systemPrompt,
        '',
        this.buildCoordinatorRosterSection(agents),
        '',
        this.buildCoordinatorOutputFormatSection(),
        '',
        this.buildCoordinatorSynthesisSection(),
      ].join('\n')
    }

    const base = this.buildCoordinatorSystemPrompt(agents)
    if (!config?.instructions) {
      return base
    }

    return [
      base,
      '',
      '## Additional Instructions',
      config.instructions,
    ].join('\n')
  }

  /** Build the coordinator team roster section. */
  private buildCoordinatorRosterSection(agents: AgentConfig[]): string {
    const roster = agents
      .map(
        (a) =>
          `- **${a.name}** (${a.model}): ${a.systemPrompt?.slice(0, 120) ?? 'general purpose agent'}`,
      )
      .join('\n')

    return [
      '## Team Roster',
      roster,
    ].join('\n')
  }

  /** Build the coordinator JSON output-format section. */
  private buildCoordinatorOutputFormatSection(): string {
    return [
      '## Output Format',
      'When asked to decompose a goal, respond ONLY with a JSON array of task objects.',
      'Each task must have:',
      '  - "title":       Short descriptive title (string)',
      '  - "description": Full task description with context and expected output (string)',
      '  - "assignee":    One of the agent names listed in the roster (string)',
      '  - "dependsOn":   Array of titles of tasks this task depends on (string[], may be empty)',
      '',
      'Wrap the JSON in a ```json code fence.',
      'Do not include any text outside the code fence.',
    ].join('\n')
  }

  /** Build the coordinator synthesis guidance section. */
  private buildCoordinatorSynthesisSection(): string {
    return [
      '## When synthesising results',
      'You will be given completed task outputs and asked to synthesise a final answer.',
      'Write a clear, comprehensive response that addresses the original goal.',
    ].join('\n')
  }

  /** Build the decomposition prompt for the coordinator. */
  private buildDecompositionPrompt(goal: string, agents: AgentConfig[]): string {
    const names = agents.map((a) => a.name).join(', ')
    return [
      `Decompose the following goal into tasks for your team (${names}).`,
      '',
      `## Goal`,
      goal,
      '',
      'Return ONLY the JSON task array in a ```json code fence.',
    ].join('\n')
  }

  /** Build the synthesis prompt shown to the coordinator after all tasks complete. */
  private async buildSynthesisPrompt(
    goal: string,
    tasks: Task[],
    team: Team,
  ): Promise<string> {
    const completedTasks = tasks.filter((t) => t.status === 'completed')
    const failedTasks = tasks.filter((t) => t.status === 'failed')
    const skippedTasks = tasks.filter((t) => t.status === 'skipped')

    const resultSections = completedTasks.map((t) => {
      const assignee = t.assignee ?? 'unknown'
      return `### ${t.title} (completed by ${assignee})\n${t.result ?? '(no output)'}`
    })

    const failureSections = failedTasks.map(
      (t) => `### ${t.title} (FAILED)\nError: ${t.result ?? 'unknown error'}`,
    )

    const skippedSections = skippedTasks.map(
      (t) => `### ${t.title} (SKIPPED)\nReason: ${t.result ?? 'approval rejected'}`,
    )

    // Also include shared memory summary for additional context
    let memorySummary = ''
    const sharedMem = team.getSharedMemoryInstance()
    if (sharedMem) {
      memorySummary = await sharedMem.getSummary()
    }

    return [
      `## Original Goal`,
      goal,
      '',
      `## Task Results`,
      ...resultSections,
      ...(failureSections.length > 0 ? ['', '## Failed Tasks', ...failureSections] : []),
      ...(skippedSections.length > 0 ? ['', '## Skipped Tasks', ...skippedSections] : []),
      ...(memorySummary ? ['', memorySummary] : []),
      '',
      '## Your Task',
      'Synthesise the above results into a comprehensive final answer that addresses the original goal.',
      'If some tasks failed or were skipped, note any gaps in the result.',
    ].join('\n')
  }

  /**
   * Load a list of task specs into a queue.
   *
   * Handles title-based `dependsOn` references by building a title→id map first,
   * then resolving them to real IDs before adding tasks to the queue.
   */
  private loadSpecsIntoQueue(
    specs: ReadonlyArray<ParsedTaskSpec & {
      memoryScope?: 'dependencies' | 'all'
      maxRetries?: number
      retryDelayMs?: number
      retryBackoff?: number
    }>,
    agentConfigs: AgentConfig[],
    queue: TaskQueue,
  ): void {
    const agentNames = new Set(agentConfigs.map((a) => a.name))

    // First pass: create tasks (without dependencies) to get stable IDs.
    const titleToId = new Map<string, string>()
    const createdTasks: Task[] = []

    for (const spec of specs) {
      const task = createTask({
        title: spec.title,
        description: spec.description,
        assignee: spec.assignee && agentNames.has(spec.assignee)
          ? spec.assignee
          : undefined,
        memoryScope: spec.memoryScope,
        maxRetries: spec.maxRetries,
        retryDelayMs: spec.retryDelayMs,
        retryBackoff: spec.retryBackoff,
      })
      titleToId.set(spec.title.toLowerCase().trim(), task.id)
      createdTasks.push(task)
    }

    // Second pass: resolve title-based dependsOn to IDs.
    for (let i = 0; i < createdTasks.length; i++) {
      const spec = specs[i]!
      const task = createdTasks[i]!

      if (!spec.dependsOn || spec.dependsOn.length === 0) {
        queue.add(task)
        continue
      }

      const resolvedDeps: string[] = []
      for (const depRef of spec.dependsOn) {
        // Accept both raw IDs and title strings
        const byId = createdTasks.find((t) => t.id === depRef)
        const byTitle = titleToId.get(depRef.toLowerCase().trim())
        const resolvedId = byId?.id ?? byTitle
        if (resolvedId) {
          resolvedDeps.push(resolvedId)
        }
      }

      const taskWithDeps: Task = {
        ...task,
        dependsOn: resolvedDeps.length > 0 ? resolvedDeps : undefined,
      }
      queue.add(taskWithDeps)
    }
  }

  /** Build an {@link AgentPool} from a list of agent configurations. */
  private buildPool(agentConfigs: AgentConfig[]): AgentPool {
    const pool = new AgentPool(this.config.maxConcurrency)
    for (const config of agentConfigs) {
      const effective: AgentConfig = {
        ...config,
        model: config.model,
        provider: config.provider ?? this.config.defaultProvider,
        baseURL: config.baseURL ?? this.config.defaultBaseURL,
        apiKey: config.apiKey ?? this.config.defaultApiKey,
      }
      pool.add(buildAgent(effective))
    }
    return pool
  }

  /**
   * Aggregate the per-run `agentResults` map into a {@link TeamRunResult}.
   *
   * Merges results keyed as `agentName:taskId` back into a per-agent map
   * by agent name for the public result surface.
   *
   * Only non-coordinator entries are counted toward `completedTaskCount` to
   * avoid double-counting the coordinator's internal decompose/synthesis steps.
   */
  private buildTeamRunResult(
    agentResults: Map<string, AgentRunResult>,
  ): TeamRunResult {
    let totalUsage: TokenUsage = ZERO_USAGE
    let overallSuccess = true
    const collapsed = new Map<string, AgentRunResult>()

    for (const [key, result] of agentResults) {
      // Strip the `:taskId` suffix to get the agent name
      const agentName = key.includes(':') ? key.split(':')[0]! : key

      totalUsage = addUsage(totalUsage, result.tokenUsage)
      if (!result.success) overallSuccess = false

      const existing = collapsed.get(agentName)
      if (!existing) {
        collapsed.set(agentName, result)
      } else {
        // Merge multiple results for the same agent (multi-task case).
        // Keep the latest `structured` value (last completed task wins).
        collapsed.set(agentName, {
          success: existing.success && result.success,
          output: [existing.output, result.output].filter(Boolean).join('\n\n---\n\n'),
          messages: [...existing.messages, ...result.messages],
          tokenUsage: addUsage(existing.tokenUsage, result.tokenUsage),
          toolCalls: [...existing.toolCalls, ...result.toolCalls],
          structured: result.structured !== undefined ? result.structured : existing.structured,
        })
      }

      // Only count actual user tasks — skip coordinator meta-entries
      // (keys that start with 'coordinator') to avoid double-counting.
      if (result.success && !key.startsWith('coordinator')) {
        this.completedTaskCount++
      }
    }

    return {
      success: overallSuccess,
      agentResults: collapsed,
      totalTokenUsage: totalUsage,
    }
  }
}
