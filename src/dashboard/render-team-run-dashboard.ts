/**
 * Pure HTML renderer for the post-run team task DAG dashboard (no filesystem or network I/O).
 */

import type { TeamRunResult } from '../types.js'
import { layoutTasks } from './layout-tasks.js'

/**
 * Escape serialized JSON so it can be embedded in HTML without closing a {@code <script>} tag.
 * The HTML tokenizer ends a script on {@code </script>} even for {@code type="application/json"}.
 */
export function escapeJsonForHtmlScript(json: string): string {
  return json.replace(/<\/script/gi, '<\\/script')
}

export function renderTeamRunDashboard(result: TeamRunResult): string {
  const generatedAt = new Date().toISOString()
  const tasks = result.tasks ?? []
  const layout = layoutTasks(tasks)
  const serializedPositions = Object.fromEntries(layout.positions)
  const payload = {
    generatedAt,
    goal: result.goal ?? '',
    tasks,
    layout: {
      positions: serializedPositions,
      width: layout.width,
      height: layout.height,
      nodeW: layout.nodeW,
      nodeH: layout.nodeH,
    },
  }
  const dataJson = escapeJsonForHtmlScript(JSON.stringify(payload))

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
    <script type="application/json" id="oma-data">${dataJson}</script>
    <script>
        const dataEl = document.getElementById("oma-data");
        const payload = JSON.parse(dataEl.textContent);
        const panel = document.getElementById("detailsPanel");
        const closeBtn = document.getElementById("closePanel");
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
            const rawLayout = payload.layout ?? {};
            const positions = new Map(Object.entries(rawLayout.positions ?? {}));
            const width = Number(rawLayout.width ?? 1600);
            const height = Number(rawLayout.height ?? 700);
            const nodeW = Number(rawLayout.nodeW ?? 256);
            const nodeH = Number(rawLayout.nodeH ?? 142);
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

                const rowTop = document.createElement("div");
                rowTop.className = "flex justify-between items-start mb-4";
                const nodeIdSpan = document.createElement("span");
                nodeIdSpan.className = "text-[10px] font-mono " + status.iconColor;
                nodeIdSpan.textContent = nodeId;
                const iconSpan = document.createElement("span");
                iconSpan.className = "material-symbols-outlined " + status.iconColor + " text-lg " + (status.spin ? "animate-spin" : "");
                iconSpan.textContent = status.icon;
                iconSpan.setAttribute("data-icon", status.icon);
                rowTop.appendChild(nodeIdSpan);
                rowTop.appendChild(iconSpan);

                const titleEl = document.createElement("h3");
                titleEl.className = "font-headline font-bold text-sm tracking-tight mb-1";
                titleEl.textContent = task.title;

                const statusLine = document.createElement("p");
                statusLine.className = "text-xs " + status.statusColor + " mb-4";
                statusLine.textContent = "STATUS: " + durationText(task);

                const chipRow = document.createElement("div");
                chipRow.className = "flex gap-2";
                chips.forEach((chip) => {
                    const chipEl = document.createElement("span");
                    chipEl.className = "px-2 py-0.5 bg-surface-variant text-[9px] font-mono text-on-surface-variant";
                    chipEl.textContent = chip;
                    chipRow.appendChild(chipEl);
                });

                node.appendChild(rowTop);
                node.appendChild(titleEl);
                node.appendChild(statusLine);
                node.appendChild(chipRow);

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
</body>
</html>`
}
