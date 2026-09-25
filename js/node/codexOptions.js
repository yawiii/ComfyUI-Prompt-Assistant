import { app } from "../../../../scripts/app.js";
import { APIService } from "../services/api.js";

const serviceWidgetNames = {
    PromptExpand: "llm_service",
    PromptTranslate: "translate_service",
};
const codexWidgetNames = ["codex_model", "codex_reasoning_effort"];
const originalWidgets = new WeakMap();
let codexServiceNames = new Set(["Codex CLI"]);

function serviceWidgetName(node) {
    return node._promptAssistantServiceWidgetName
        ?? serviceWidgetNames[node.comfyClass]
        ?? serviceWidgetNames[node.type];
}

function setWidgetVisible(widget, visible) {
    if (!widget) return false;
    if (!originalWidgets.has(widget)) {
        originalWidgets.set(widget, {
            computeSize: widget.computeSize,
            draw: widget.draw,
            displays: new Map(),
        });
    }
    if (widget._promptAssistantCodexVisible === visible) return false;

    const original = originalWidgets.get(widget);
    widget.computeSize = visible ? original.computeSize : () => [0, -4];
    widget.draw = visible ? original.draw : () => {};
    widget._promptAssistantCodexVisible = visible;
    for (const element of [widget.element, widget.inputEl, widget.domElement]) {
        if (!element?.style) continue;
        if (!original.displays.has(element)) original.displays.set(element, element.style.display);
        element.style.display = visible ? original.displays.get(element) : "none";
    }
    return true;
}

function updateCodexOptions(node) {
    const serviceWidget = node.widgets?.find((widget) => widget.name === serviceWidgetName(node));
    if (!serviceWidget) return;

    const serviceName = String(serviceWidget.value ?? "").split("/", 1)[0];
    const visible = codexServiceNames.has(serviceName);
    const previousHeight = node.computeSize?.()[1] ?? node.size?.[1] ?? 0;
    let changed = false;
    for (const name of codexWidgetNames) {
        const widget = node.widgets?.find((item) => item.name === name);
        changed = setWidgetVisible(widget, visible) || changed;
    }
    if (!changed) return;

    const minimumHeight = node.computeSize?.()[1] ?? previousHeight;
    if (node.size && node.setSize) {
        node.setSize([node.size[0], Math.max(minimumHeight, node.size[1] + minimumHeight - previousHeight)]);
    }
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas(true, true);
}

function attachCodexOptions(node) {
    if (!serviceWidgetName(node)) return;
    const serviceWidget = node.widgets?.find((widget) => widget.name === serviceWidgetName(node));
    if (!serviceWidget) return;
    if (!serviceWidget._promptAssistantCodexCallbackWrapped) {
        const previousCallback = serviceWidget.callback;
        serviceWidget.callback = function (...args) {
            const result = previousCallback?.apply(this, args);
            updateCodexOptions(node);
            return result;
        };
        serviceWidget._promptAssistantCodexCallbackWrapped = true;
    }
    updateCodexOptions(node);
}

function updateAllNodes() {
    for (const node of app.graph?._nodes ?? []) attachCodexOptions(node);
}

async function loadCodexServices() {
    try {
        const response = await fetch(APIService.getApiUrl("/services"));
        if (!response.ok) return;
        const data = await response.json();
        if (!data.success) return;
        codexServiceNames = new Set(
            (data.services ?? [])
                .filter((service) => service.type === "codex_cli")
                .map((service) => service.name)
        );
        updateAllNodes();
    } catch (error) {
        console.warn("[Prompt Assistant] Could not load Codex services", error);
    }
}

app.registerExtension({
    name: "Comfy.PromptAssistant.CodexOptions",
    setup() {
        loadCodexServices();
        window.addEventListener("pa-config-updated", loadCodexServices);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!serviceWidgetNames[nodeData.name]) return;
        nodeType.prototype._promptAssistantServiceWidgetName = serviceWidgetNames[nodeData.name];
        const originalCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalCreated?.apply(this, args);
            requestAnimationFrame(() => attachCodexOptions(this));
            return result;
        };
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalConfigure?.apply(this, args);
            requestAnimationFrame(() => attachCodexOptions(this));
            return result;
        };
    },
    nodeCreated(node) {
        requestAnimationFrame(() => attachCodexOptions(node));
    },
});
