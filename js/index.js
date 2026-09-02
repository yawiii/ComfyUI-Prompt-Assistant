/**
 * 提示词小助手 (PromptAssistant) 主入口文件
 * 负责扩展初始化、节点检测和功能注入
 */

import { app } from "../../../scripts/app.js";
import { promptAssistant, PromptAssistant } from './modules/PromptAssistant.js';
import { registerSettings } from './modules/settings.js';
import { FEATURES as ASSISTANT_FEATURES, handleFeatureChange, setFeatureModuleDeps } from './services/features.js';
import { EventManager } from './utils/eventManager.js';
import { ResourceManager } from './utils/resourceManager.js';
import { UIToolkit } from "./utils/UIToolkit.js";
import { logger } from './utils/logger.js';
import { HistoryCacheService, TagCacheService } from './services/cache.js';
import { imageCaption, ImageCaption } from './modules/imageCaption.js';
import { nodeHelpTranslator } from './modules/nodeHelpTranslator.js';
import { nodeMountService, RENDER_MODE } from './services/NodeMountService.js';
import { tUI } from "./utils/uiI18n.js";
import './node/captionFrame.js'; // 导入视频手动抽帧功能
import './node/dynamicImageInputs.js'; // 图像反推节点动态多图输入（最多9图）



// ====================== 全局配置与状态 ======================

// 设置全局对象供其他模块访问
window.FEATURES = ASSISTANT_FEATURES;

// 将实例添加到全局对象
window.promptAssistant = promptAssistant;
window.imageCaption = imageCaption;

// 将实例添加到全局app对象
app.promptAssistant = promptAssistant;
app.imageCaption = imageCaption;

// ====================== 扩展注册 ======================

/**
 * 注册ComfyUI扩展
 */
app.registerExtension({
    name: "Comfy.PromptAssistant",

    // ---扩展生命周期钩子---
    /**
     * 初始化扩展
     */
    async setup() {
        try {
            // 初始化节点挂载服务（需要在其他初始化之前）
            nodeMountService.initialize();

            // 注册渲染模式切换处理
            nodeMountService.onModeChange(async (newMode, oldMode) => {
                logger.log(`[index] 渲染模式切换检测 | ${oldMode} -> ${newMode}`);
                // 重新初始化所有小助手
                if (window.FEATURES.enabled) {
                    // 先清理所有现有实例
                    promptAssistant.cleanup(null, true);
                    imageCaption.cleanup(null, true);

                    // 等待一帧确保 DOM 更新
                    await new Promise(resolve => requestAnimationFrame(resolve));

                    await promptAssistant.toggleGlobalFeature(true, true);
                    if (window.FEATURES.imageCaption) {
                        await imageCaption.toggleGlobalFeature(true, true);
                    }
                    logger.log(`[index] 渲染模式切换后重新初始化完成`);
                }
            });

            // 注册设置选项
            await registerSettings();

            // 初始化自动翻译拦截器（独立于提示词小助手）


            // 初始化提示词小助手（内部会处理版本号检查和总开关状态）
            await promptAssistant.initialize();

            // 初始化图像小助手（只初始化一次）
            if (!imageCaption.initialized) {
                await imageCaption.initialize();
            }

            // 清理旧引用
            if (app.canvas) {
                app.canvas.updateNodeAssistantsVisibility = null;
                app.canvas._onNodeSelectionChange = null;
            }

            // 将管理器添加到app对象，使其可以通过window.app访问
            app.EventManager = EventManager;
            app.ResourceManager = ResourceManager;
            app.UIToolkit = UIToolkit;

            // 先初始化 features.js 依赖
            setFeatureModuleDeps({
                promptAssistant,
                PromptAssistant,
                UIToolkit,
                HistoryCacheService,
                TagCacheService,
                imageCaption,
                ImageCaption,
                nodeHelpTranslator
            });

            // 然后再自动注册服务功能
            if (window.FEATURES.enabled) {
                await promptAssistant.toggleGlobalFeature(true, true);
                // 避免重复初始化，只在必要时启用图像小助手功能
                if (window.FEATURES.imageCaption) {
                    await imageCaption.toggleGlobalFeature(true, false);
                }
                // 初始化节点帮助翻译模块（根据功能开关）
                if (window.FEATURES.nodeHelpTranslator) {
                    nodeHelpTranslator.initialize();
                }
            }

            logger.debug("扩展初始化完成");
        } catch (error) {
            logger.error(`扩展初始化失败: ${error.message}`);
        }

        // 延迟hook Note/MarkdownNote/PreviewAny节点类型
        setTimeout(() => {
            try {
                const NoteNodeType = LiteGraph.registered_node_types['Note'];
                const MarkdownNoteNodeType = LiteGraph.registered_node_types['MarkdownNote'];
                const PreviewAnyNodeType = LiteGraph.registered_node_types['PreviewAny'];
                const PreviewTextNodeType = LiteGraph.registered_node_types['PreviewTextNode'];

                if (NoteNodeType) this._hookNoteNodeType(NoteNodeType, 'Note');
                if (MarkdownNoteNodeType) this._hookNoteNodeType(MarkdownNoteNodeType, 'MarkdownNote');
                if (PreviewAnyNodeType) this._hookNoteNodeType(PreviewAnyNodeType, 'PreviewAny');
                if (PreviewTextNodeType) this._hookNoteNodeType(PreviewTextNodeType, 'PreviewTextNode');

                // 可能的其他名称变体
                const altNames = ['PreviewText', 'Preview as Text', 'Markdown Preview'];
                altNames.forEach(name => {
                    const nodeType = LiteGraph.registered_node_types[name];
                    if (nodeType) {
                        this._hookNoteNodeType(nodeType, name);
                        logger.debug(`[setup] 注入Preview节点成功 | 类型: ${name}`);
                    }
                });
            } catch (error) {
                logger.error(`[setup] Hook Note节点失败: ${error.message}`);
            }
        }, 50);

        // ---全局节点监听---
        this._bindGraphHooks(app.graph);

        // ---子图进入/退出监听（Vue Node 2.0 自动创建支持）---
        this._setupGraphSwitchListener();

        // 暴露 _injectUniversalHooks 供外部使用
        app.registerExtension._injectUniversalHooks = this._injectUniversalHooks.bind(this);

        // --- 监听后端警告事件 (如帧数截断) ---
        app.api.addEventListener("prompt_assistant.warning", ({ detail }) => {
            if (detail?.type === "frame_truncated") {
                const summary = tUI("帧数已截断", "⚠️ Frames Truncated");
                const detailMsg = tUI("帧数截断详情", "Model supports max {max} frames, {truncated} frame(s) ignored")
                    .replace("{max}", detail.max_images)
                    .replace("{truncated}", detail.truncated);
                
                app.extensionManager?.toast?.add({
                    severity: "warn",
                    summary: summary,
                    detail: detailMsg,
                    life: 8000,
                });
            }
        });
    },

    /**
     * 设置画布 graph 切换监听器
     * 检测进入/退出子图事件，自动创建模式下重新扫描节点
     */
    _setupGraphSwitchListener() {
        if (!app.canvas) return;

        // 记录上一次的 graph 引用
        let lastGraph = app.canvas.graph;
        const self = this;

        // 通过 Object.defineProperty hook app.canvas.graph 的 setter
        // 当 graph 切换（进入/退出子图）时触发扫描
        const originalDescriptor = Object.getOwnPropertyDescriptor(app.canvas, 'graph') || {
            value: app.canvas.graph,
            writable: true,
            configurable: true
        };
        
        // 备份以便调试恢复
        window.__PA_ORIG_GRAPH_DESC__ = originalDescriptor;

        // 保存原始值
        let _graphValue = app.canvas.graph;

        Object.defineProperty(app.canvas, 'graph', {
            get() {
                return _graphValue;
            },
            set(newGraph) {
                const oldGraph = _graphValue;
                _graphValue = newGraph;

                // 如果有原始 setter，调用它
                if (originalDescriptor.set) {
                    originalDescriptor.set.call(this, newGraph);
                }

                // 检测 graph 切换
                if (newGraph && newGraph !== oldGraph) {
                    logger.debug(`[graphSwitch] 检测到画布切换 | 旧Graph: ${oldGraph?._workflow_id || 'unknown'} -> 新Graph: ${newGraph?._workflow_id || 'unknown'}`);

                    // 延迟执行，确保画布切换完成
                    const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
                    const delay = isVueMode ? 300 : 100;

                    setTimeout(() => {
                        self._onGraphSwitch(newGraph);
                    }, delay);
                }
            },
            configurable: true,
            enumerable: true
        });

        logger.debug('[graphSwitch] 画布切换监听器已设置');
    },

    /**
     * 画布切换后的处理逻辑
     * 复用 _bindGraphHooks 的扫描逻辑，避免代码重复
     * @param {object} graph - 新的 graph 对象
     */
    _onGraphSwitch(graph) {
        if (!graph || !window.FEATURES.enabled) return;

        // 调用已有的绑定钩子方法，并传入 resetFlags 选项以重置节点初始化标记
        this._bindGraphHooks(graph, { resetFlags: true });
    },

    /**
     * 为指定 graph 绑定节点挂载钩子
     * 支持主画布和子图内部
     * @param {object} graph - graph 对象
     * @param {object} options - 选项 { resetFlags: 是否重置节点初始化标记 }
     */
    _bindGraphHooks(graph, options = {}) {
        if (!graph) return;
        const { resetFlags = false } = options;

        // 绑定钩子（只执行一次）
        if (!graph._promptAssistantHooksInjected) {
            graph._promptAssistantHooksInjected = true;

            const origOnNodeAdded = graph.onNodeAdded;
            graph.onNodeAdded = (node) => {
                if (origOnNodeAdded) origOnNodeAdded.apply(graph, [node]);

                if (!window.FEATURES.enabled || !node) return;

                // 1. 动态注入 Hooks (onSelected, onRemoved)
                this._injectUniversalHooks(node);

                // 2. 自动挂载尝试
                this._handleNodeActive(node, { delay: true });
            };

            // logger.log(`[graphHooks] 已绑定 graph 钩子 | ID: ${graph._workflow_id || graph.constructor?.name || 'unknown'}`);

            // 【关键】处理进入子图时已存在的节点
            // Vue 模式需要更长延迟，确保 DOM 渲染完成
            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
            const scanDelay = isVueMode ? 500 : 100;

            const scanExistingNodes = () => {
                if (!window.FEATURES.enabled) return;

                const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";

                // 只要任意一个模块开启了自动创建，就需要扫描现有节点
                if (creationMode !== "auto" && icCreationMode !== "auto") {
                    // logger.debugSample(() => `[graphHooks] 跳过初始扫描 | PA模式: ${creationMode} | IC模式: ${icCreationMode}`);
                    return;
                }

                const nodes = graph._nodes || [];
                if (nodes.length === 0) return;

                nodes.forEach(node => {
                    if (!node || node.id === -1) return;

                    // 1. 注入钩子 (确保 onSelected/onRemoved 等能正常工作)
                    this._injectUniversalHooks(node);

                    // 2. 统一分发到激活处理函数，它内部会根据各自的自动创建设置进行判断
                    this._handleNodeActive(node, { delay: false });
                });
            };

            setTimeout(scanExistingNodes, scanDelay);
        }

        // 【新增】如果需要重置标记（子图切换场景），立即扫描现有节点
        if (resetFlags) {
            // 切换图时，先清理当前 UI 实例（不清理缓存），防止 ID 冲突的残留
            promptAssistant.cleanup(null, true);

            const isVueMode = typeof LiteGraph !== 'undefined' && LiteGraph.vueNodesMode === true;
            const delay = isVueMode ? 300 : 100;

            setTimeout(() => {
                const nodes = graph._nodes || [];
                nodes.forEach(node => {
                    if (!node || node.id === -1) return;

                    // 重置初始化标记，允许重新创建
                    node._promptAssistantInitialized = false;
                    node._imageCaptionInitialized = false;

                    // 注入钩子
                    this._injectUniversalHooks(node);

                    // 触发自动创建
                    this._handleNodeActive(node, { delay: false });
                });

                if (nodes.length > 0) {
                    const gId = graph.id || graph._workflow_id || 'main';
                    logger.debug(`[graphSwitch] 自动扫描完成 | 节点数: ${nodes.length} | Graph: ${gId}`);
                }
            }, delay);
        }
    },

    /**
     * 为所有节点注入通用的交互钩子 (onSelected, onRemoved)
     * 特别是针对动态创建的子图节点，确确保能够响应点击和资源清理
     * @param {object} node - LiteGraph 节点实例
     */
    _injectUniversalHooks(node) {
        if (!node || node._promptAssistantHooksInjected) return;

        const self = this;
        const origOnSelected = node.onSelected;
        const origOnRemoved = node.onRemoved;

        // 实例级覆盖 (针对动态创建或特殊节点)
        node.onSelected = function () {
            if (origOnSelected) origOnSelected.apply(this, arguments);
            self._handleNodeActive(this, { reset: true, delay: true });
        };

        node.onRemoved = function () {
            self._handleNodeCleanup(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        node._promptAssistantHooksInjected = true;
    },

    /**
     * @deprecated 已由 _injectUniversalHooks 替代，保留用于注册时的遗留支持
     */
    _hookNoteNodeType(NodeType, typeName) {
        if (!NodeType || !NodeType.prototype) return;

        // 我们不再重写原型方法，而是通过 onNodeAdded 动态注入实例方法
        // 这在 Node 2.0 动态创建时更可靠
        // logger.debug(`[_hookNoteNodeType] 类型已注册: ${typeName}`);
    },

    // ---其他方法保持不变---
    async _setupOtherMethods() {
        const self = this;
        // 仅保留工作流ID识别功能，不处理工作流切换事件
        try {
            const LGraph = app.graph.constructor;
            const origConfigure = LGraph.prototype.configure;
            LGraph.prototype.configure = function (data) {
                // 在图表对象上存储工作流ID
                this._workflow_id = data.id || LiteGraph.uuidv4();

                // 执行原始方法
                return origConfigure.apply(this, arguments);
            };

            // 添加工作流加载监听，只标记切换状态，不做特殊处理
            const origLoadGraphData = app.loadGraphData;
            app.loadGraphData = async function (data) {
                // 设置工作流切换标记，避免删除缓存
                window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = true;

                // 简化日志：仅在工作流ID变化时打印一次
                const workflowId = data?.id || (data?.extra?.workflow_id) || "未知工作流";
                if (app.graph?._workflow_id !== workflowId) {
                    logger.log(`[工作流] 切换: ${workflowId}`);
                }

                try {
                    // 调用原始加载方法
                    const result = await origLoadGraphData.apply(this, arguments);

                    // 工作流加载完成后，统一处理现有节点的激活（包括自动创建判定）
                    requestAnimationFrame(() => {
                        if (app.graph && app.graph._nodes) {
                            app.graph._nodes.forEach(node => {
                                if (node && node.id !== -1) {
                                    self._handleNodeActive(node, { delay: false });
                                }
                            });
                        }
                    });

                    return result;
                } finally {
                    // 延迟重置工作流切换标记
                    setTimeout(() => {
                        window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING = false;
                    }, 500);
                }
            };
        } catch (e) {
            logger.error("[PromptAssistant] 注入 LGraph 设置工作流ID失败", e);
        }
    },

    // ---节点生命周期钩子---
    /**
     * 节点创建钩子
     * 在节点创建时初始化特定类型节点的小助手
     */
    async nodeCreated(node) {
        // nodeCreated 钩子现在主要用于补齐子图节点的特殊交互，大部分逻辑已通过 onNodeCreated 注入
        if (!node || node.id === -1) return;
        this._injectUniversalHooks(node);
    },

    async nodeRemoved(node) {
        if (window.PROMPT_ASSISTANT_WORKFLOW_SWITCHING) return;
        this._handleNodeCleanup(node);
    },

    /**
     * 节点定义注册前钩子
     * 向所有节点类型注入小助手相关功能
     */


    // --- 统一生命周期管理逻辑 (重构点) ---

    /**
     * 统一处理节点的“进入/激活”逻辑
     * 涵盖：新节点创建(onNodeCreated), 全局节点添加(onNodeAdded), 节点选中(onSelected)
     * @param {object} node - 节点实例
     * @param {object} options - 配置参数 { reset: 是否强制重置标记, delay: 是否使用 raf 延迟 }
     */
    _handleNodeActive(node, options = {}) {
        if (!node || !window.FEATURES.enabled) return;
        if (node.id === -1) return;

        const { reset = false, delay = true } = options;
        if (reset) {
            node._promptAssistantInitialized = false;
            node._imageCaptionInitialized = false;
        }

        const run = () => {
            if (!node || !node.id || node.id === -1) return;

            // 1. 提示词小助手核心入口
            if (PromptAssistant.isValidNode(node)) {
                const creationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.CreationMode") || "auto";
                if ((creationMode === "auto" || reset) && !node._promptAssistantInitialized) {
                    node._promptAssistantInitialized = true;
                    promptAssistant.checkAndSetupNode(node);
                }
            }

            // 2. 图像反推小助手入口
            const isSupportedICNode = imageCaption.isSupportedNode && imageCaption.isSupportedNode(node);
            if (window.FEATURES.imageCaption && isSupportedICNode) {
                const icCreationMode = app.ui.settings.getSettingValue("PromptAssistant.Settings.ImageCaptionCreationMode") || "auto";
                if (reset && app.canvas?._imageCaptionSelectionHandler) {
                    node._imageCaptionInitialized = false;
                    app.canvas._imageCaptionSelectionHandler({ [node.id]: node });
                } else if (icCreationMode === "auto" && !node._imageCaptionInitialized) {
                    node._imageCaptionInitialized = true;
                    imageCaption.checkAndSetupNode(node);
                }
            }
        };

        if (delay) {
            requestAnimationFrame(() => requestAnimationFrame(run));
        } else {
            run();
        }
    },

    /**
     * 统一处理节点的“销毁/清理”逻辑
     * @param {object} node - 节点实例
     */
    _handleNodeCleanup(node) {
        if (!node || node.id === undefined || node.id === -1) return;
        const nodeId = node.id;

        // 执行清理并标记状态
        if (node._promptAssistantInitialized || !node._promptAssistantCleaned) {
            promptAssistant.cleanup(nodeId, false);
            node._promptAssistantCleaned = true;
        }
        if (node._imageCaptionInitialized || !node._imageCaptionCleaned) {
            imageCaption.cleanup(nodeId, false);
            node._imageCaptionCleaned = true;
        }
    },

    /**
     * 注册前的批量原型注入
     */
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const self = this;
        const proto = nodeType.prototype;

        const origOnCreated = proto.onNodeCreated;
        const origOnSelected = proto.onSelected;
        const origOnRemoved = proto.onRemoved;

        // 注入创建钩子 (原型级补救)
        proto.onNodeCreated = function () {
            if (origOnCreated) origOnCreated.apply(this, arguments);
            self._handleNodeActive(this, { delay: true });
        };

        // 注入选中钩子 (原型级补救)
        proto.onSelected = function () {
            if (origOnSelected) origOnSelected.apply(this, arguments);
            self._handleNodeActive(this, { reset: true, delay: true });
        };

        // 注入移除钩子 (原型级补救)
        proto.onRemoved = function () {
            self._handleNodeCleanup(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };
    },

    /**
     * 扩展卸载钩子
     * 在扩展被卸载时清理所有资源
     */
    async beforeExtensionUnload() {
        promptAssistant.cleanup();
        imageCaption.cleanup();
    }
});

export { EventManager, UIToolkit };
